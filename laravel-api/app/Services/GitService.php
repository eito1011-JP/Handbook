<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class GitService
{
    protected string $githubToken;

    protected string $githubOwner;

    protected string $githubRepo;

    protected string $baseBranch;

    public function __construct()
    {
        $this->githubToken = config('services.github.token');
        $this->githubOwner = config('services.github.owner');
        $this->githubRepo = config('services.github.repo');
        $this->baseBranch = config('services.github.base_branch', 'main');
    }

    /**
     * リモートブランチを作成
     */
    public function createRemoteBranch(string $branchName, string $sha): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/git/refs";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->post($url, [
            'ref' => "refs/heads/{$branchName}",
            'sha' => $sha,
        ]);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Create Branch: '.$response->body());

            throw new \Exception('ブランチの作成に失敗しました');
        }

        return $response->json();
    }

    /**
     * ツリーを作成
     */
    public function createTree(string $baseTreeSha, array $treeItems): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/git/trees";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->post($url, [
            'base_tree' => $baseTreeSha,
            'tree' => $treeItems,
        ]);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Create Tree: '.$response->body());

            throw new \Exception('ツリーの作成に失敗しました');
        }

        return $response->json();
    }

    /**
     * コミットを作成
     */
    public function createCommit(string $message, string $treeSha, array $parents, bool $autoMerge = false): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/git/commits";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->post($url, [
            'message' => $message,
            'tree' => $treeSha,
            'parents' => $parents,
        ]);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Create Commit: '.$response->body());

            throw new \Exception('コミットの作成に失敗しました');
        }

        return $response->json();
    }

    /**
     * ブランチの参照を更新
     */
    public function updateBranchReference(string $branchName, string $sha): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/git/refs/heads/{$branchName}";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->patch($url, [
            'sha' => $sha,
            'force' => false,
        ]);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Update Branch Reference: '.$response->body());

            throw new \Exception('ブランチ参照の更新に失敗しました');
        }

        return $response->json();
    }

    /**
     * プルリクエストを作成
     */
    public function createPullRequest(string $branchName, string $title, string $body): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/pulls";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->post($url, [
            'title' => $title,
            'body' => $body,
            'head' => $branchName,
            'base' => $this->baseBranch,
        ]);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Create Pull Request: '.$response->body());

            throw new \Exception('プルリクエストの作成に失敗しました');
        }

        $responseData = $response->json();

        return [
            'pr_url' => $responseData['html_url'],
            'pr_number' => $responseData['number'],
        ];
    }

    /**
     * プルリクエストにレビュアーを追加
     */
    public function addReviewersToPullRequest(int $prNumber, array $reviewers): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/pulls/{$prNumber}/requested_reviewers";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->post($url, [
            'reviewers' => $reviewers,
            'team_reviewers' => [],
        ]);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Add Reviewers: '.$response->body());

            throw new \Exception('レビュアーの追加に失敗しました');
        }

        return $response->json();
    }

    /**
     * プルリクエストをマージ
     */
    public function mergePullRequest(int $prNumber, string $mergeMethod = 'merge', bool $updateBranch = true): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/pulls/{$prNumber}/merge";

        $requestData = [
            'merge_method' => $mergeMethod,
        ];
        
        // GitHub Enterprise Server以外の場合はupdate_branchパラメータを追加
        if ($updateBranch) {
            $requestData['update_branch'] = true;
        }

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->put($url, $requestData);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Merge Pull Request: '.$response->body());

            throw new \Exception('プルリクエストのマージに失敗しました');
        }

        return $response->json();
    }

    /**
     * プルリクエストの情報を取得（コンフリクト検知用）
     */
    public function getPullRequestInfo(int $prNumber): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/pulls/{$prNumber}";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->get($url);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Get Pull Request Info: '.$response->body());

            throw new \Exception('プルリクエスト情報の取得に失敗しました');
        }

        $data = $response->json();

        return [
            'mergeable' => $data['mergeable'] ?? null,
            'mergeable_state' => $data['mergeable_state'] ?? 'unknown',
            'rebaseable' => $data['rebaseable'] ?? null,
        ];
    }

    /**
     * プルリクエストをクローズ
     */
    public function closePullRequest(int $prNumber): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/pulls/{$prNumber}";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->patch($url, [
            'state' => 'closed',
        ]);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Close Pull Request: '.$response->body());

            throw new \Exception('プルリクエストのクローズに失敗しました');
        }

        return $response->json();
    }

    /**
     * ブランチの参照情報を取得
     */
    public function getBranchReference(string $branchName): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/git/refs/heads/{$branchName}";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->get($url);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Get Branch Reference: '.$response->body());

            throw new \Exception('ブランチ参照の取得に失敗しました');
        }

        return $response->json();
    }

    /**
     * マージコミットを作成
     */
    public function createMergeCommit(string $message, string $baseSha, string $headSha): array
    {
        // まず、両方のブランチのコミット情報を取得
        $baseCommit = $this->getCommit($baseSha);
        $headCommit = $this->getCommit($headSha);
        
        // マージされたツリーSHAを使用（通常はheadのツリーを使用）
        $mergedTreeSha = $headCommit['tree']['sha'];
        
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/git/commits";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->post($url, [
            'message' => $message,
            'tree' => $mergedTreeSha,
            'parents' => [$baseSha, $headSha],
        ]);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Create Merge Commit: '.$response->body());

            throw new \Exception('マージコミットの作成に失敗しました');
        }

        return $response->json();
    }

    /**
     * コミット情報を取得
     */
    public function getCommit(string $sha): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/git/commits/{$sha}";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->get($url);

        if (! $response->successful()) {
            Log::error('GitHub API Error - Get Commit: '.$response->body());

            throw new \Exception('コミット情報の取得に失敗しました');
        }

        return $response->json();
    }

    /**
     * プルリクエストブランチを最新状態に更新
     */
    public function updatePullRequestBranch(int $prNumber): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/pulls/{$prNumber}/update-branch";

        // expected_head_shaパラメータを送信しない（空のボディ）
        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->put($url);

        if (! $response->successful()) {
            $responseBody = $response->body();
            Log::error('GitHub API Error - Update PR Branch: '.$responseBody);
            
            // すでに最新の場合は例外を投げない
            $responseData = json_decode($responseBody, true);
            if (isset($responseData['message'])) {
                $message = $responseData['message'];
                if (strpos($message, 'merge conflict') !== false ||
                    strpos($message, 'conflicts') !== false) {
                    throw new \Exception('マージコンフリクトが発生しました');
                }
                if (strpos($message, 'up to date') !== false ||
                    strpos($message, 'already up-to-date') !== false ||
                    strpos($message, 'already current') !== false) {
                    return ['message' => 'Already up to date'];
                }
            }

            throw new \Exception('プルリクエストブランチの更新に失敗しました: ' . $responseBody);
        }

        $result = $response->json();
        
        // レスポンスがnullの場合のフォールバック
        if ($result === null) {
            return ['message' => 'Branch updated'];
        }

        return $result;
    }

    /**
     * ブランチをbaseブランチにマージ（upstream sync）
     */
    public function mergeUpstream(string $headBranch, string $baseBranch = 'main'): array
    {
        $url = "https://api.github.com/repos/{$this->githubOwner}/{$this->githubRepo}/merges";

        $response = Http::withHeaders([
            'Authorization' => "token {$this->githubToken}",
            'Accept' => 'application/vnd.github.v3+json',
        ])->post($url, [
            'base' => $headBranch,     // マージ先（PRブランチ）
            'head' => $baseBranch,     // マージ元（mainブランチ）
            'commit_message' => "Merge {$baseBranch} into {$headBranch}",
        ]);

        if (! $response->successful()) {
            $responseBody = $response->body();
            Log::error('GitHub API Error - Merge Upstream: '.$responseBody);
            
            // すでに最新の場合は例外を投げない
            $responseData = json_decode($responseBody, true);
            if (isset($responseData['message'])) {
                $message = $responseData['message'];
                if (strpos($message, 'Nothing to merge') !== false || 
                    strpos($message, 'already up-to-date') !== false ||
                    strpos($message, 'up to date') !== false) {
                    return ['message' => 'Already up to date'];
                }
            }

            throw new \Exception('アップストリームマージに失敗しました: ' . $responseBody);
        }

        $result = $response->json();
        
        // レスポンスがnullの場合のフォールバック
        if ($result === null) {
            return ['message' => 'Merge completed'];
        }

        return $result;
    }
}
