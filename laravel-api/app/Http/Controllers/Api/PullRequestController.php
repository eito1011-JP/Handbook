<?php

namespace App\Http\Controllers\Api;

use App\Constants\DocumentCategoryConstants;
use App\Consts\Flag;
use App\Enums\DocumentCategoryStatus;
use App\Enums\DocumentStatus;
use App\Enums\PullRequestActivityAction;
use App\Enums\PullRequestReviewerActionStatus;
use App\Enums\PullRequestStatus;
use App\Enums\UserRole;
use App\Enums\FixRequestStatus;
use App\Http\Requests\Api\PullRequest\ApprovePullRequestRequest;
use App\Http\Requests\Api\PullRequest\ClosePullRequestRequest;
use App\Http\Requests\Api\PullRequest\DetectConflictRequest;
use App\Http\Requests\Api\PullRequest\FetchActivityLogRequest;
use App\Http\Requests\Api\PullRequest\MergePullRequestRequest;
use App\Http\Requests\Api\PullRequest\UpdatePullRequestTitleRequest;
use App\Http\Requests\CreatePullRequestRequest;
use App\Http\Requests\FetchPullRequestDetailRequest;
use App\Http\Requests\FetchPullRequestsRequest;
use App\Models\ActivityLogOnPullRequest;
use App\Models\DocumentCategory;
use App\Models\DocumentVersion;
use App\Models\PullRequest;
use App\Models\PullRequestEditSession;
use App\Models\PullRequestReviewer;
use App\Models\User;
use App\Services\CategoryFolderService;
use App\Services\DocumentDiffService;
use App\Services\GitService;
use App\Services\MdFileService;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class PullRequestController extends ApiBaseController
{
    protected DocumentDiffService $documentDiffService;

    protected GitService $gitService;

    protected MdFileService $mdFileService;

    protected CategoryFolderService $categoryFolderService;

    public function __construct(
        DocumentDiffService $documentDiffService,
        GitService $gitService,
        MdFileService $mdFileService,
        CategoryFolderService $categoryFolderService
    ) {
        $this->documentDiffService = $documentDiffService;
        $this->gitService = $gitService;
        $this->mdFileService = $mdFileService;
        $this->categoryFolderService = $categoryFolderService;
    }

    /**
     * プルリクエスト作成
     */
    public function createPullRequest(CreatePullRequestRequest $request): JsonResponse
    {
        Log::info('request: '.json_encode($request->all()));
        DB::beginTransaction();

        try {
            // 1. 認証ユーザーか確認
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            // 2. diffをidとuser_branch_idで絞り込んでfetch
            $userBranch = $user->userBranches()
                ->active()
                ->orderBy('id', 'desc')
                ->first();

            if (! $userBranch) {
                return response()->json([
                    'error' => 'ユーザーブランチが見つかりません',
                ], 404);
            }

            // 3. diffアイテムを取得
            $diffItems = $request->diff_items;
            $documentVersions = collect();
            $documentCategories = collect();

            Log::info('diffItems: '.json_encode($diffItems));

            // document と category のIDを分別して一括取得用の配列を作成
            $documentIds = [];
            $categoryIds = [];

            foreach ($diffItems as $item) {
                if ($item['type'] === 'document') {
                    $documentIds[] = $item['id'];
                } elseif ($item['type'] === 'category') {
                    $categoryIds[] = $item['id'];
                }
            }

            // 一括でDocumentVersionsを取得
            if (! empty($documentIds)) {
                $documentVersions = DocumentVersion::where('user_branch_id', $userBranch->id)
                    ->whereIn('id', $documentIds)
                    ->get();

                // 取得したdocumentsのstatusをpushedにbulk update
                DocumentVersion::where('user_branch_id', $userBranch->id)
                    ->whereIn('id', $documentIds)
                    ->update(['status' => DocumentStatus::PUSHED->value]);
            }

            // 一括でDocumentCategoriesを取得
            if (! empty($categoryIds)) {
                $documentCategories = DocumentCategory::where('user_branch_id', $userBranch->id)
                    ->whereIn('id', $categoryIds)
                    ->get();

                // 取得したcategoriesのstatusをpushedにbulk update
                DocumentCategory::where('user_branch_id', $userBranch->id)
                    ->whereIn('id', $categoryIds)
                    ->update(['status' => DocumentCategoryStatus::PUSHED->value]);
            }

            // 4. tree api用にpath, contentを動的に作成
            $treeItems = [];

            foreach ($documentVersions as $documentVersion) {
                $markdownContent = $this->mdFileService->createMdFileContent($documentVersion);
                Log::info('slug: '.$documentVersion->slug);
                Log::info('category_path: '.$documentVersion->category_path);
                $filePath = $this->mdFileService->generateFilePath($documentVersion->slug, $documentVersion->category_path);
                Log::info('filePath: '.$filePath);
                $treeItems[] = [
                    'path' => $filePath,
                    'mode' => '100644',
                    'type' => 'blob',
                    'content' => $markdownContent,
                ];
            }

            foreach ($documentCategories as $documentCategory) {
                // _category_.jsonファイルの内容を作成
                $categoryJsonData = [
                    'label' => $documentCategory->sidebar_label,
                    'position' => $documentCategory->position,
                    'link' => [
                        'type' => 'generated-index',
                        'description' => $documentCategory->description,
                    ],
                ];
                $categoryJsonContent = json_encode($categoryJsonData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);

                $categoryFolderPath = $this->categoryFolderService->generateCategoryFilePath($documentCategory->slug, $documentCategory->parent_id && $documentCategory->parent_id !== DocumentCategoryConstants::DEFAULT_CATEGORY_ID ? $documentCategory->parent_id : null);

                Log::info('categoryFolderPath: '.$categoryFolderPath);
                // _category_.jsonファイルを作成
                $treeItems[] = [
                    'path' => $categoryFolderPath.'/_category_.json',
                    'mode' => '100644',
                    'type' => 'blob',
                    'content' => $categoryJsonContent,
                ];

                // .gitkeepファイルを作成（空のフォルダをGitで追跡するため）
                $treeItems[] = [
                    'path' => $categoryFolderPath.'/.gitkeep',
                    'mode' => '100644',
                    'type' => 'blob',
                    'content' => '',
                ];
            }

            // 5. GitHubのrepositoryにリモートbranchを作成
            $branchResult = $this->gitService->createRemoteBranch(
                $userBranch->branch_name,
                $userBranch->snapshot_commit
            );

            // 6. リモートレポジトリで直接ファイルを編集（tree作成）
            $treeResult = $this->gitService->createTree(
                $userBranch->snapshot_commit,
                $treeItems
            );

            // 7. コミット作成
            $commitResult = $this->gitService->createCommit(
                $request->title,
                $treeResult['sha'],
                [$userBranch->snapshot_commit]
            );

            // 8. ブランチの最新コミットを更新
            $this->gitService->updateBranchReference(
                $userBranch->branch_name,
                $commitResult['sha']
            );

            // 9. プルリクエスト作成
            $prResult = $this->gitService->createPullRequest(
                $userBranch->branch_name,
                $request->title,
                $request->description ?? ''
            );

            // 10. レビュアー設定
            $reviewerUserIds = [];
            if ($request->reviewers && ! empty($request->reviewers)) {
                // レビュアーのGitHubユーザー名を取得
                $reviewerUsers = User::whereIn('email', $request->reviewers)->get();
                $reviewerUsernames = [];

                foreach ($reviewerUsers as $reviewerUser) {
                    $reviewerUserIds[] = $reviewerUser->id;
                    // GitHubユーザー名がある場合は追加（今回は仮でemailのローカル部分を使用）
                    $reviewerUsernames[] = explode('@', $reviewerUser->email)[0];
                }

                // レビュアーを設定
                $this->gitService->addReviewersToPullRequest(
                    $prResult['pr_number'],
                    $reviewerUsernames
                );
            }

            // 11. pull_requestsテーブルにデータを保存
            $pullRequest = PullRequest::create([
                'user_branch_id' => $userBranch->id,
                'title' => $request->title,
                'description' => $request->description,
                'github_url' => $prResult['pr_url'],
                'pr_number' => $prResult['pr_number'],
                'status' => PullRequestStatus::OPENED->value,
            ]);

            // 12. pull_request_reviewersテーブルにレビュアーを保存
            if (! empty($reviewerUserIds)) {
                $reviewerData = array_map(function ($reviewerUserId) use ($pullRequest) {
                    return [
                        'pull_request_id' => $pullRequest->id,
                        'user_id' => $reviewerUserId,
                    ];
                }, $reviewerUserIds);

                PullRequestReviewer::insert($reviewerData);
            }

            // 13. ユーザーブランチのステータスを更新
            $userBranch->update([
                'is_active' => Flag::FALSE,
            ]);

            DB::commit();

            return response()->json([
                'success' => true,
                'message' => 'プルリクエストを作成しました',
                'pr_url' => $prResult['pr_url'],
                'pr_number' => $prResult['pr_number'],
            ]);

        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('プルリクエスト作成エラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json([
                'error' => 'プルリクエストの作成に失敗しました',
            ], 500);
        }
    }

    /**
     * プルリクエスト一覧を取得
     */
    public function fetchPullRequests(FetchPullRequestsRequest $request): JsonResponse
    {
        try {
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            $email = $request->validated('email');
            $statusFilters = $request->validated('status');

            // statusパラメータが指定されている場合はそれを使用、そうでなければ未対応のみ
            $defaultStatuses = [PullRequestStatus::OPENED->value, PullRequestStatus::CONFLICT->value];
            $statuses = $statusFilters ? $statusFilters : $defaultStatuses;

            $query = PullRequest::with('userBranch.user')
                ->whereIn('status', $statuses)
                ->orderByDesc('created_at')
                ->when($email, function ($query) use ($email) {
                    return $query->whereHas('userBranch.user', function ($q) use ($email) {
                        $q->where('email', 'like', $email.'%');
                    });
                });

            $pulls = $query->paginate(10);

            $counts = PullRequest::selectRaw(
                'SUM(status IN (?,?)) AS opened_count,
                 SUM(status IN (?,?)) AS closed_count',
                [
                    PullRequestStatus::OPENED->value,
                    PullRequestStatus::CONFLICT->value,
                    PullRequestStatus::CLOSED->value,
                    PullRequestStatus::MERGED->value,
                ]
            )->first();

            $response = collect($pulls->items())->map(function ($pullRequest) {
                return [
                    'id' => $pullRequest->id,
                    'title' => $pullRequest->title,
                    'status' => $pullRequest->status,
                    'email' => $pullRequest->userBranch->user->email ?? null,
                    'github_url' => $pullRequest->github_url,
                    'created_at' => $pullRequest->created_at,
                ];
            });

            return response()->json([
                'pull_requests' => $response,
                'total_opened_count' => $counts->opened_count,
                'total_closed_count' => $counts->closed_count,
                'pagination' => [
                    'current_page' => $pulls->currentPage(),
                    'last_page' => $pulls->lastPage(),
                ],
            ]);

        } catch (\Exception $e) {
            Log::error('プルリクエスト一覧取得エラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json([
                'error' => 'プルリクエスト一覧の取得に失敗しました',
            ], 500);
        }
    }

    /**
     * プルリクエスト詳細を取得
     */
    public function fetchPullRequestDetail(FetchPullRequestDetailRequest $request): JsonResponse
    {
        try {
            // 1. 認証ユーザーか確認
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            // 2. プルリクエストを取得（status = opened or conflict）
            $pullRequest = PullRequest::with([
                'userBranch.user',
                'userBranch.editStartVersions',
                'userBranch.editStartVersions.originalDocumentVersion',
                'userBranch.editStartVersions.currentDocumentVersion',
                'userBranch.editStartVersions.originalDocumentVersion.category',
                'userBranch.editStartVersions.currentDocumentVersion.category',
                'userBranch.editStartVersions.originalCategory',
                'userBranch.editStartVersions.currentCategory',
                'reviewers.user',
            ])
                ->where('id', $request->validated('id'))
                ->firstOrFail();

            // 3. 差分データを生成
            $diffResult = $this->documentDiffService->generateDiffData($pullRequest->userBranch->editStartVersions);

            // 4. レビュアー情報を取得
            $reviewers = $pullRequest->reviewers->map(function ($reviewer) {
                return [
                    'user_id' => $reviewer->user->id,
                    'email' => $reviewer->user->email,
                    'action_status' => $reviewer->action_status,
                ];
            })->toArray();

            // 5. プルリクエスト作成者の名前とメールアドレスを取得
            $authorName = $pullRequest->userBranch->user->name ?? null;
            $authorEmail = $pullRequest->userBranch->user->email ?? null;

            return response()->json([
                ...$diffResult,
                'title' => $pullRequest->title,
                'description' => $pullRequest->description,
                'status' => $pullRequest->status,
                'author_name' => $authorName,
                'author_email' => $authorEmail,
                'reviewers' => $reviewers,
                'created_at' => $pullRequest->created_at,
            ]);

        } catch (\Exception $e) {
            Log::error('プルリクエスト詳細取得エラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
                'pull_request_id' => $request->validated('id'),
            ]);

            return response()->json([
                'error' => 'プルリクエスト詳細の取得に失敗しました',
            ], 500);
        }
    }

    /**
     * プルリクエストをマージ
     */
    public function merge(MergePullRequestRequest $request): JsonResponse
    {
        DB::beginTransaction();

        try {
            // 1. ログイン認証
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            // 2. ログインユーザーのroleがowner or adminであることを確認
            if (! UserRole::from($user->role)->isAdmin() && ! UserRole::from($user->role)->isOwner()) {
                return response()->json([
                    'error' => '権限がありません',
                ], 403);
            }

            // 3. プルリクエストを取得（status = opened）
            $pullRequest = PullRequest::with(['userBranch', 'pullRequestEditSessions.editSessionDiffs', 'fixRequests'])
                ->where('id', $request->pull_request_id)
                ->where('status', PullRequestStatus::OPENED->value)
                ->firstOrFail();

            // 4. PR提出時から差分が変わっているかをチェック
            $pullRequestEditSession = $pullRequest->pullRequestEditSessions()
                ->whereNotNull('finished_at')
                ->first();

            $appliedFixRequest = $pullRequest->fixRequests()
                ->where('status', FixRequestStatus::APPLIED->value)
                ->first();

            // 5. PR提出時と差分が変わっていない場合
            if (!$pullRequestEditSession && !$appliedFixRequest) {
                // GitHub APIでプルリクエストをマージ
                $this->gitService->mergePullRequest($pullRequest->pr_number);
            } else {
                // 6. PR提出時から差分が変更されている場合
                
                // 6-1. プルリクエストに紐づくdocument_versionsとdocument_categoriesを取得
                $userBranch = $pullRequest->userBranch;
                $documentVersions = $userBranch->documentVersions()->get();
                $documentCategories = $userBranch->documentCategories()->get();

                // 6-2. applied fix requestのversion_idを取得
                $appliedDocumentVersionIds = [];
                $appliedCategoryVersionIds = [];
                if ($appliedFixRequest) {
                    $allAppliedFixRequests = $pullRequest->fixRequests()
                        ->where('status', FixRequestStatus::APPLIED->value)
                        ->get();
                    
                    $appliedDocumentVersionIds = $allAppliedFixRequests->pluck('document_version_id')->filter()->toArray();
                    $appliedCategoryVersionIds = $allAppliedFixRequests->pluck('document_category_id')->filter()->toArray();
                }

                // 6-3. 再編集されたdocumentとcategoryのidを取得
                $reEditDocumentVersionsIds = [];
                $reEditCategoryVersionsIds = [];
                if ($pullRequestEditSession) {
                    $pullRequestEditSessionDiffs = $pullRequestEditSession->editSessionDiffs;
                    
                    $reEditDocumentVersionsIds = $pullRequestEditSessionDiffs
                        ->where('target_type', 'document')
                        ->pluck('current_version_id')
                        ->filter()
                        ->toArray();
                    
                    $reEditCategoryVersionsIds = $pullRequestEditSessionDiffs
                        ->where('target_type', 'category')
                        ->pluck('current_version_id')
                        ->filter()
                        ->toArray();
                }

                // 6-4. 新しいバージョンIDをマージ
                $newDocumentVersionIds = array_merge($appliedDocumentVersionIds, $reEditDocumentVersionsIds);
                $newCategoryVersionIds = array_merge($appliedCategoryVersionIds, $reEditCategoryVersionsIds);

                // 6-5. 対象のdocumentVersionsとcategoryVersionsを取得
                $targetDocumentVersions = $documentVersions->whereIn('id', $newDocumentVersionIds);
                $targetCategoryVersions = $documentCategories->whereIn('id', $newCategoryVersionIds);

                $treeItems = [];

                // 6-6. documentVersionsを処理
                foreach ($targetDocumentVersions as $documentVersion) {
                    $markdownContent = $this->mdFileService->createMdFileContent($documentVersion);
                    $filePath = $this->mdFileService->generateFilePath($documentVersion->slug, $documentVersion->category_path);
                    
                    $treeItems[] = [
                        'path' => $filePath,
                        'mode' => '100644',
                        'type' => 'blob',
                        'content' => $markdownContent,
                    ];
                }

                // 6-7. categoryVersionsを処理
                foreach ($targetCategoryVersions as $documentCategory) {
                    $categoryJsonData = [
                        'label' => $documentCategory->sidebar_label,
                        'position' => $documentCategory->position,
                        'link' => [
                            'type' => 'generated-index',
                            'description' => $documentCategory->description,
                        ],
                    ];
                    
                    $categoryJsonContent = json_encode($categoryJsonData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
                    
                    $categoryFolderPath = $this->categoryFolderService->generateCategoryFilePath(
                        $documentCategory->slug, 
                        $documentCategory->parent_id && $documentCategory->parent_id !== DocumentCategoryConstants::DEFAULT_CATEGORY_ID 
                            ? $documentCategory->parent_id 
                            : null
                    );
                    
                    // _category_.jsonファイルを作成
                    $treeItems[] = [
                        'path' => $categoryFolderPath.'/_category_.json',
                        'mode' => '100644',
                        'type' => 'blob',
                        'content' => $categoryJsonContent,
                    ];
                    
                    // .gitkeepファイルを作成（空のフォルダをGitで追跡するため）
                    $treeItems[] = [
                        'path' => $categoryFolderPath.'/.gitkeep',
                        'mode' => '100644',
                        'type' => 'blob',
                        'content' => '',
                    ];
                }

                // 6-8. treeを作成して、リモートブランチのファイルを編集
                $treeResult = $this->gitService->createTree(
                    $userBranch->snapshot_commit,
                    $treeItems
                );

                // 6-9. コミット作成
                $commitResult = $this->gitService->createCommit(
                    $pullRequest->title,
                    $treeResult['sha'],
                    [$userBranch->snapshot_commit]
                );

                // 6-10. ブランチの最新コミットを更新
                $this->gitService->updateBranchReference(
                    $userBranch->branch_name,
                    $commitResult['sha']
                );

                // GitHub APIでプルリクエストをマージ
                $this->gitService->mergePullRequest($pullRequest->pr_number);
            }

            // 7. プルリクエストに紐づくuser_branchesテーブルを取得し、
            // それに紐づくdocument_versionsとdocument_categoriesのstatusをmergedにupdate
            $userBranch = $pullRequest->userBranch;

            // DocumentVersionsのstatusを更新
            $userBranch->documentVersions()->update([
                'status' => DocumentStatus::MERGED->value,
            ]);

            // DocumentCategoriesのstatusを更新
            $userBranch->documentCategories()->update([
                'status' => DocumentCategoryStatus::MERGED->value,
            ]);

            // 8. pull_requestsテーブルのstatusをmergedにupdate
            $pullRequest->update([
                'status' => PullRequestStatus::MERGED->value,
            ]);

            // 9. ActivityLogを作成
            ActivityLogOnPullRequest::create([
                'user_id' => $user->id,
                'pull_request_id' => $pullRequest->id,
                'action' => PullRequestActivityAction::PULL_REQUEST_MERGED->value,
            ]);

            DB::commit();

            return response()->json();

        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('プルリクエストマージエラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
                'pull_request_id' => $request->pull_request_id,
            ]);

            return response()->json([
                'error' => 'プルリクエストのマージに失敗しました',
            ], 500);
        }
    }

    /**
     * プルリクエストのコンフリクト状態を検知
     */
    public function detectConflict(DetectConflictRequest $request): JsonResponse
    {
        try {
            // 1. 認証ユーザーか確認
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            // 2. プルリクエストを取得
            $pullRequest = PullRequest::find($request->id);

            if (! $pullRequest) {
                return response()->json([
                    'error' => 'プルリクエストが見つかりません',
                ], 404);
            }

            // 3. GitHub APIでプルリクエスト情報を取得
            $prInfo = $this->gitService->getPullRequestInfo($pullRequest->pr_number);

            return response()->json([
                'mergeable' => $prInfo['mergeable'],
                'mergeable_state' => $prInfo['mergeable_state'],
            ]);

        } catch (\Exception $e) {
            Log::error('プルリクエストコンフリクト検知エラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
                'pull_request_id' => $request->id,
            ]);

            return response()->json([
                'error' => 'コンフリクト検知に失敗しました',
            ], 500);
        }
    }

    /**
     * プルリクエストをクローズ
     */
    public function close(ClosePullRequestRequest $request, int $id): JsonResponse
    {
        DB::beginTransaction();

        try {
            // 1. 認証ユーザーか確認
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            // 2. プルリクエストを取得（Form Requestでバリデーション済み）
            $pullRequest = PullRequest::find($id);

            // 3. GitHub APIでプルリクエストをクローズ
            $this->gitService->closePullRequest($pullRequest->pr_number);

            // 4. pull_requestsテーブルのstatusをclosedに更新
            $pullRequest->update([
                'status' => PullRequestStatus::CLOSED->value,
            ]);

            // 5. ActivityLogを作成
            ActivityLogOnPullRequest::create([
                'user_id' => $user->id,
                'pull_request_id' => $pullRequest->id,
                'action' => PullRequestActivityAction::PULL_REQUEST_CLOSED->value,
            ]);

            DB::commit();

            return response()->json();

        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('プルリクエストクローズエラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
                'pull_request_id' => $id,
            ]);

            return response()->json([
                'error' => 'プルリクエストのクローズに失敗しました',
            ], 500);
        }
    }

    /**
     * プルリクエストを承認する
     */
    public function approve(ApprovePullRequestRequest $request): JsonResponse
    {
        try {
            // 1. 認証ユーザーか確認
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            // 2. バリデーション済みデータを取得
            $validated = $request->validated();
            $pullRequestId = $validated['pull_request_id'];

            // 3. 該当のレビュアーレコードを取得または作成
            $reviewer = PullRequestReviewer::where('pull_request_id', $pullRequestId)
                ->where('user_id', $user->id)
                ->first();

            if (! $reviewer) {
                // レビュアーとして登録されていない場合は新規作成
                $reviewer = PullRequestReviewer::create([
                    'pull_request_id' => $pullRequestId,
                    'user_id' => $user->id,
                    'action_status' => PullRequestReviewerActionStatus::APPROVED,
                ]);
            } else {
                // 既存のレビュアーレコードを更新
                $reviewer->update([
                    'action_status' => PullRequestReviewerActionStatus::APPROVED,
                ]);
            }

            // ActivityLogを作成
            ActivityLogOnPullRequest::create([
                'user_id' => $user->id,
                'pull_request_id' => $pullRequestId,
                'action' => PullRequestActivityAction::REVIEWER_APPROVED->value,
            ]);

            return response()->json();

        } catch (\Exception $e) {
            Log::error('プルリクエスト承認エラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
                'pull_request_id' => $request->pull_request_id ?? null,
                'user_id' => $user->id ?? null,
            ]);

            return response()->json([
                'error' => 'プルリクエストの承認に失敗しました',
            ], 500);
        }
    }

    /**
     * プルリクエストのアクティビティログを取得
     */
    public function fetchActivityLog(FetchActivityLogRequest $request, int $id): JsonResponse
    {
        try {
            // 1. 認証ユーザーか確認
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            // 2. バリデーション済みのプルリクエストIDを取得
            $pullRequestId = $request->validated('id');

            // 3. activity_log_on_pull_requestsから該当するログを取得
            $activityLogs = ActivityLogOnPullRequest::with([
                'user:id,name,email',
                'comment:id,content,created_at',
                'fixRequest:id,token,created_at',
                'reviewer:id,name,email',
                'pullRequestEditSession:id,token,created_at',
            ])
                ->where('pull_request_id', $pullRequestId)
                ->orderBy('created_at', 'asc')
                ->get();

            // 4. レスポンス形式に変換
            $response = $activityLogs->map(function ($log) {
                return [
                    'id' => $log->id,
                    'pull_request_id' => $log->pull_request_id,
                    'action' => $log->action,
                    'actor' => $log->user ? [
                        'id' => $log->user->id,
                        'name' => $log->user->name ?? $log->user->email,
                        'email' => $log->user->email,
                    ] : null,
                    'comment' => $log->comment ? [
                        'id' => $log->comment->id,
                        'content' => $log->comment->content,
                        'created_at' => $log->comment->created_at->toISOString(),
                    ] : null,
                    'fix_request' => $log->fixRequest ? [
                        'id' => $log->fixRequest->id,
                        'token' => $log->fixRequest->token,
                        'created_at' => $log->fixRequest->created_at->toISOString(),
                    ] : null,
                    'pull_request_edit_session' => $log->pullRequestEditSession ? [
                        'id' => $log->pullRequestEditSession->id,
                        'token' => $log->pullRequestEditSession->token,
                        'created_at' => $log->pullRequestEditSession->created_at->toISOString(),
                    ] : null,
                    'old_pull_request_title' => $log->old_pull_request_title,
                    'new_pull_request_title' => $log->new_pull_request_title,
                    'fix_request_token' => $log->fix_request_token,
                    'created_at' => $log->created_at->toISOString(),
                ];
            });

            return response()->json($response);

        } catch (\Exception $e) {
            Log::error('アクティビティログ取得エラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
                'pull_request_id' => $id,
                'user_id' => $user->id ?? null,
            ]);

            return response()->json([
                'error' => 'アクティビティログの取得に失敗しました',
            ], 500);
        }
    }

    /**
     * プルリクエストのタイトルを更新する
     */
    public function updateTitle(UpdatePullRequestTitleRequest $request, int $id): JsonResponse
    {
        DB::beginTransaction();

        try {
            // 1. 認証ユーザーか確認
            $user = $this->getUserFromSession();

            if (! $user) {
                return response()->json([
                    'error' => '認証されていません',
                ], 401);
            }

            // 2. pull_requestsテーブルをpull_request_idにてfirstOrFail
            $pullRequest = PullRequest::findOrFail($id);

            // 3. 新しいタイトルを取得
            $newTitle = $request->validated('title');

            // 4. activity_log_on_pull_requestsテーブルにレコードを作成
            ActivityLogOnPullRequest::create([
                'user_id' => $user->id,
                'pull_request_id' => $pullRequest->id,
                'action' => PullRequestActivityAction::PULL_REQUEST_TITLE_EDITED->value,
                'old_pull_request_title' => $pullRequest->title,
                'new_pull_request_title' => $newTitle,
            ]);

            // 5. プルリクエストレコードのtitleをrequest.titleにupdate
            $pullRequest->update([
                'title' => $newTitle,
            ]);

            DB::commit();

            return response()->json();

        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('プルリクエストタイトル更新エラー: '.$e->getMessage(), [
                'exception' => $e,
                'trace' => $e->getTraceAsString(),
                'pull_request_id' => $id,
                'user_id' => $user->id ?? null,
            ]);

            return response()->json([
                'error' => 'プルリクエストタイトルの更新に失敗しました',
            ], 500);
        }
    }
}
