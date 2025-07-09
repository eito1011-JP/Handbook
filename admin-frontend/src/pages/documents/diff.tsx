import AdminLayout from '@/components/admin/layout';
import { useState, useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { useSessionCheck } from '@/hooks/useSessionCheck';
import { apiClient } from '@/components/admin/api/client';
import { API_CONFIG } from '@/components/admin/api/config';
import { Folder } from '@/components/icon/common/Folder';
import React from 'react';
import { markdownToHtml } from '@/utils/markdownToHtml';
import { DocumentDetailed } from '@/components/icon/common/DocumentDetailed';
import { Settings } from '@/components/icon/common/Settings';
import { createPullRequest, type DiffItem as ApiDiffItem } from '@/api/pullRequest';

// 差分データの型定義
type DiffItem = {
  id: number;
  slug: string;
  sidebar_label: string;
  description?: string;
  title?: string;
  content?: string;
  position?: number;
  file_order?: number;
  parent_id?: number;
  category_id?: number;
  status: string;
  user_branch_id: number;
  created_at: string;
  updated_at: string;
};

type DiffFieldInfo = {
  status: 'added' | 'deleted' | 'modified' | 'unchanged';
  current: any;
  original: any;
};

type DiffDataInfo = {
  id: number;
  type: 'document' | 'category';
  operation: 'created' | 'updated' | 'deleted';
  changed_fields: Record<string, DiffFieldInfo>;
};

type DiffResponse = {
  document_versions: DiffItem[];
  document_categories: DiffItem[];
  original_document_versions?: DiffItem[];
  original_document_categories?: DiffItem[];
  diff_data: DiffDataInfo[];
};

// 新しい差分表示コンポーネント（GitHubライク）
const SmartDiffValue = ({
  label,
  fieldInfo,
  isMarkdown = false,
}: {
  label: string;
  fieldInfo: DiffFieldInfo;
  isMarkdown?: boolean;
}) => {
  const renderValue = (value: any) => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
    if (typeof value === 'number') return value.toString();
    return value;
  };

  const renderContent = (content: string, isMarkdown: boolean) => {
    if (isMarkdown) {
      return <div dangerouslySetInnerHTML={{ __html: markdownToHtml(content) }} />;
    }
    return content;
  };

  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-gray-300 mb-2">{label}</label>

      {fieldInfo.status === 'added' && (
        <div className="bg-green-900/30 border border-green-700 rounded-md p-3 text-sm text-green-200">
          {renderContent(renderValue(fieldInfo.current), isMarkdown)}
        </div>
      )}

      {fieldInfo.status === 'deleted' && (
        <div className="bg-red-900/30 border border-red-700 rounded-md p-3 text-sm text-red-200">
          {renderContent(renderValue(fieldInfo.original), isMarkdown)}
        </div>
      )}

      {fieldInfo.status === 'modified' && (
        <>
          <div className="bg-red-900/30 border border-red-700 rounded-md p-3 text-sm text-red-200 mb-1">
            <span className="text-red-400 text-xs font-medium mr-2">-</span>
            {renderContent(renderValue(fieldInfo.original), isMarkdown)}
          </div>
          <div className="bg-green-900/30 border border-green-700 rounded-md p-3 text-sm text-green-200">
            <span className="text-green-400 text-xs font-medium mr-2">+</span>
            {renderContent(renderValue(fieldInfo.current), isMarkdown)}
          </div>
        </>
      )}

      {fieldInfo.status === 'unchanged' && (
        <div className="bg-gray-800 border border-gray-600 rounded-md p-3 text-sm text-gray-300">
          {renderContent(renderValue(fieldInfo.current || fieldInfo.original), isMarkdown)}
        </div>
      )}
    </div>
  );
};

// 階層パンくずリストコンポーネント
const SlugBreadcrumb = ({ slug }: { slug: string }) => {
  const slugParts = slug.split('/').filter(part => part.length > 0);
  let currentPath = '';

  return (
    <div className="mb-3">
      <div className="flex items-center text-sm text-gray-400 mb-2">
        {slugParts.map((part, index) => {
          // パスを構築（現在までの部分）
          currentPath += (index === 0 ? '' : '/') + part;

          return (
            <React.Fragment key={index}>
              <span>/</span>
              {index > 0 && (
                <span className="mx-2">
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M9 5l7 7-7 7"
                    ></path>
                  </svg>
                </span>
              )}
              {index === slugParts.length - 1 ? (
                <span className="text-gray-400">{part}</span>
              ) : (
                <span className="text-gray-400">{part}</span>
              )}
            </React.Fragment>
          );
        })}
      </div>
      <div className="border-b border-gray-700"></div>
    </div>
  );
};

/**
 * 差分確認画面コンポーネント
 */
export default function DiffPage(): JSX.Element {
  const { isLoading } = useSessionCheck('/login', false);

  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState('');
  const [prDescription, setPrDescription] = useState('');
  const [selectedReviewers, setSelectedReviewers] = useState<number[]>([]);
  const [showReviewerModal, setShowReviewerModal] = useState(false);
  const [reviewerSearch, setReviewerSearch] = useState('');
  const reviewerModalRef = useRef<HTMLDivElement | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const handleReviewerChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const options = Array.from(e.target.selectedOptions);
    setSelectedReviewers(options.map(opt => Number(opt.value)));
  };

  // ユーザー一覧を取得する関数
  const handleFetchUser = async (searchEmail?: string) => {
    setLoadingUsers(true);
    try {
      const endpoint = searchEmail
        ? `${API_CONFIG.ENDPOINTS.PULL_REQUEST_REVIEWERS.GET}?email=${encodeURIComponent(searchEmail)}`
        : API_CONFIG.ENDPOINTS.PULL_REQUEST_REVIEWERS.GET;

      const response = await apiClient.get(endpoint);
      setUsers(response.users || []);
    } catch (error) {
      console.error('ユーザー取得エラー:', error);
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  };

  // レビュアーモーダルが表示された時にユーザー一覧を取得
  useEffect(() => {
    if (showReviewerModal) {
      handleFetchUser();
    }
  }, [showReviewerModal]);

  // レビュアー検索時の処理
  useEffect(() => {
    if (showReviewerModal && reviewerSearch) {
      const timeoutId = setTimeout(() => {
        handleFetchUser(reviewerSearch);
      }, 300);

      return () => clearTimeout(timeoutId);
    }
  }, [reviewerSearch, showReviewerModal]);

  useEffect(() => {
    const fetchDiff = async () => {
      try {
        // URLパラメータからuser_branch_idを取得
        const urlParams = new URLSearchParams(window.location.search);
        const userBranchId = urlParams.get('user_branch_id');

        if (!userBranchId) {
          setError('user_branch_idパラメータが必要です');
          setLoading(false);
          return;
        }

        const response = await apiClient.get(
          `${API_CONFIG.ENDPOINTS.USER_BRANCHES.GET_DIFF}?user_branch_id=${userBranchId}`
        );

        setDiffData(response);
      } catch (err) {
        console.error('差分取得エラー:', err);
        setError('差分データの取得に失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchDiff();
  }, []);

  useEffect(() => {
    if (!showReviewerModal) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (reviewerModalRef.current && !reviewerModalRef.current.contains(event.target as Node)) {
        setShowReviewerModal(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showReviewerModal]);

  // PR作成のハンドラー
  const handleSubmitPR = async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(null);

    try {
      // URLパラメータからuser_branch_idを取得
      const urlParams = new URLSearchParams(window.location.search);
      const userBranchId = urlParams.get('user_branch_id');

      if (!userBranchId) {
        setSubmitError('user_branch_idパラメータが必要です');
        return;
      }

      // diffアイテムを構築
      const diffItems: ApiDiffItem[] = [];

      // ドキュメントバージョンを追加
      if (diffData?.document_versions) {
        diffData.document_versions.forEach(doc => {
          diffItems.push({
            id: doc.id,
            type: 'document',
          });
        });
      }

      // カテゴリを追加
      if (diffData?.document_categories) {
        diffData.document_categories.forEach(cat => {
          diffItems.push({
            id: cat.id,
            type: 'category',
          });
        });
      }

      // レビュアーのメールアドレスを取得
      const reviewerEmails =
        selectedReviewers.length > 0
          ? users.filter(user => selectedReviewers.includes(user.id)).map(user => user.email)
          : undefined;

      // デバッグログ
      console.log('送信データ:', {
        user_branch_id: parseInt(userBranchId),
        title: prTitle || '更新内容の提出',
        description: prDescription || 'このPRはハンドブックの更新を含みます。',
        diff_items: diffItems,
        reviewers: reviewerEmails,
        selectedReviewers,
        users: users.map(u => ({ id: u.id, email: u.email })),
      });

      // PRタイトル・説明をAPIに渡す
      const response = await createPullRequest({
        user_branch_id: parseInt(userBranchId),
        title: prTitle || '更新内容の提出',
        description: prDescription || 'このPRはハンドブックの更新を含みます。',
        diff_items: diffItems,
        reviewers: reviewerEmails,
      });

      if (response.success) {
        const successMessage = response.pr_url
          ? `差分の提出が完了しました。PR: ${response.pr_url}`
          : '差分の提出が完了しました';
        setSubmitSuccess(successMessage);
        // 3秒後にドキュメント一覧に戻る
        setTimeout(() => {
          window.location.href = '/admin/documents';
        }, 3000);
      } else {
        setSubmitError(response.message || '差分の提出に失敗しました');
      }
    } catch (err) {
      console.error('差分提出エラー:', err);
      setSubmitError('差分の提出中にエラーが発生しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 差分データをIDでマップ化
  const getDiffInfoById = (id: number, type: 'document' | 'category'): DiffDataInfo | null => {
    if (!diffData?.diff_data) return null;
    return diffData.diff_data.find(diff => diff.id === id && diff.type === type) || null;
  };

  // フィールド情報を取得（差分データがない場合は未変更として扱う）
  const getFieldInfo = (
    diffInfo: DiffDataInfo | null,
    fieldName: string,
    currentValue: any,
    originalValue?: any
  ): DiffFieldInfo => {
    if (!diffInfo) {
      return {
        status: 'unchanged',
        current: currentValue,
        original: originalValue,
      };
    }

    // 削除されたアイテムの場合、すべてのフィールドを削除済みとして扱う
    if (diffInfo.operation === 'deleted') {
      return {
        status: 'deleted',
        current: null,
        original: originalValue,
      };
    }

    if (!diffInfo.changed_fields[fieldName]) {
      return {
        status: 'unchanged',
        current: currentValue,
        original: originalValue,
      };
    }
    return diffInfo.changed_fields[fieldName];
  };

  // セッション確認中はローディング表示
  if (isLoading) {
    return (
      <AdminLayout title="読み込み中...">
        <div className="flex flex-col items-center justify-center h-full">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white mb-4"></div>
        </div>
      </AdminLayout>
    );
  }

  // データ読み込み中
  if (loading) {
    return (
      <AdminLayout title="差分確認">
        <div className="flex flex-col items-center justify-center h-full">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white mb-4"></div>
          <p className="text-gray-400">差分データを読み込み中...</p>
        </div>
      </AdminLayout>
    );
  }

  // エラー表示
  if (error) {
    return (
      <AdminLayout title="差分確認">
        <div className="flex flex-col items-center justify-center h-full">
          <div className="mb-4 p-3 bg-red-900/50 border border-red-800 rounded-md text-red-200">
            <div className="flex items-center">
              <svg
                className="w-5 h-5 mr-2 text-red-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span>{error}</span>
            </div>
          </div>
          <button
            className="px-4 py-2 bg-[#3832A5] rounded-md hover:bg-[#28227A] focus:outline-none"
            onClick={() => (window.location.href = '/admin/documents')}
          >
            ドキュメント一覧に戻る
          </button>
        </div>
      </AdminLayout>
    );
  }

  // データが空の場合
  if (
    !diffData ||
    (diffData.document_categories.length === 0 && diffData.document_versions.length === 0)
  ) {
    return (
      <AdminLayout title="差分確認">
        <div className="flex flex-col items-center justify-center h-full">
          <p className="text-gray-400 mb-4">変更された内容はありません</p>
          <button
            className="px-4 py-2 bg-[#3832A5] rounded-md hover:bg-[#28227A] focus:outline-none"
            onClick={() => (window.location.href = '/admin/documents')}
          >
            ドキュメント一覧に戻る
          </button>
        </div>
      </AdminLayout>
    );
  }

  // original/currentをslugでマッピング
  const mapBySlug = (arr: DiffItem[]) => Object.fromEntries(arr.map(item => [item.slug, item]));

  const originalDocs = mapBySlug(diffData.original_document_versions || []);
  const currentDocs = mapBySlug(diffData.document_versions || []);

  const originalCats = mapBySlug(diffData.original_document_categories || []);
  const currentCats = mapBySlug(diffData.document_categories || []);

  return (
    <AdminLayout title="差分確認">
      <div className="flex flex-col h-full">
        {/* 成功メッセージ */}
        {submitSuccess && (
          <div className="mb-4 p-3 bg-green-900/50 border border-green-800 rounded-md text-green-200">
            <div className="flex items-center">
              <svg
                className="w-5 h-5 mr-2 text-green-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span>{submitSuccess}</span>
            </div>
            <p className="text-sm mt-2">3秒後にドキュメント一覧に戻ります...</p>
            {submitSuccess.includes('PR:') && (
              <p className="text-sm mt-1">
                <a
                  href={submitSuccess.split('PR: ')[1]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-300 hover:text-blue-200 underline"
                >
                  PRを開く
                </a>
              </p>
            )}
          </div>
        )}

        {/* エラーメッセージ */}
        {submitError && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-800 rounded-md text-red-200">
            <div className="flex items-center">
              <svg
                className="w-5 h-5 mr-2 text-red-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
              <span>{submitError}</span>
            </div>
          </div>
        )}

        {/* PR作成セクション（画像のようなデザイン） */}
        <div className="mb-20 w-full rounded-lg relative">
          {/* タイトル入力欄とレビュアーを重ねて配置 */}
          <div className="mb-6 relative w-full">
            <div className="mb-6 relative max-w-3xl w-full">
              <label className="block text-white text-base font-medium mb-3">タイトル</label>
              <input
                type="text"
                className="w-full px-4 py-3 pr-40 rounded-lg border border-gray-600 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                placeholder=""
                value={prTitle}
                onChange={e => setPrTitle(e.target.value)}
                disabled={isSubmitting}
              />
            </div>

            <div className="absolute right-0 top-0 flex flex-col items-start mr-20">
              <div className="flex items-center gap-40 relative" ref={reviewerModalRef}>
                <span className="text-white text-base font-bold">レビュアー</span>
                <Settings
                  className="w-5 h-5 text-gray-300 ml-2 cursor-pointer"
                  onClick={() => setShowReviewerModal(v => !v)}
                />
                {showReviewerModal && (
                  <div className="absolute left-0 top-full z-50 mt-2 w-full bg-[#181A1B] rounded-xl border border-gray-700 shadow-2xl">
                    <div className="flex flex-col">
                      <div className="px-5 pt-5 pb-2 border-b border-gray-700">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-white font-semibold text-base">
                            最大15人までリクエストできます
                          </span>
                        </div>
                        <input
                          type="text"
                          className="w-full px-3 py-2 rounded bg-[#222426] border border-gray-600 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                          placeholder="Type or choose a user"
                          value={reviewerSearch}
                          onChange={e => setReviewerSearch(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {/* Suggestionsセクション */}
                      <div className="px-5 pt-3">
                        <div className="text-xs text-gray-400 font-semibold mb-2">Suggestions</div>
                        {loadingUsers ? (
                          <div className="text-gray-500 text-sm py-2">読み込み中...</div>
                        ) : users.length === 0 ? (
                          <div className="text-gray-500 text-sm py-2">ユーザーが見つかりません</div>
                        ) : (
                          users
                            .filter(user =>
                              user.email.toLowerCase().includes(reviewerSearch.toLowerCase())
                            )
                            .map(user => (
                              <div
                                key={user.id}
                                className={`flex items-center gap-3 px-2 py-2 rounded cursor-pointer hover:bg-[#23272d] ${selectedReviewers.includes(user.id) ? 'bg-[#23272d]' : ''}`}
                                onClick={() =>
                                  setSelectedReviewers(
                                    selectedReviewers.includes(user.id)
                                      ? selectedReviewers.filter(id => id !== user.id)
                                      : [...selectedReviewers, user.id]
                                  )
                                }
                              >
                                <span className="text-2xl">👤</span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-white font-medium leading-tight">
                                    {user.email}
                                  </div>
                                  <div className="text-xs text-gray-400 truncate">
                                    {user.role || 'editor'}
                                  </div>
                                </div>
                              </div>
                            ))
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {selectedReviewers.length === 0 ? (
                <p className="text-white text-base font-medium mt-5 text-sm">レビュアーなし</p>
              ) : (
                <div className="mt-5">
                  <div className="space-y-1">
                    {selectedReviewers.map(reviewerId => {
                      const user = users.find(u => u.id === reviewerId);
                      return user ? (
                        <div key={reviewerId} className="flex items-center gap-2 text-sm">
                          <span className="text-xl">👤</span>
                          <span className="text-gray-300">{user.email}</span>
                        </div>
                      ) : null;
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="mb-8">
              <div className="mb-6 relative max-w-3xl w-full">
                <label className="block text-white text-base font-medium mb-3 max-w-3xl">
                  本文
                </label>
                <textarea
                  className="w-full px-4 py-3 rounded-lg border border-gray-600 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none"
                  placeholder=""
                  rows={5}
                  value={prDescription}
                  onChange={e => setPrDescription(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>
            </div>

            <div className="flex gap-4 justify-end max-w-3xl">
              <button
                className="px-6 py-2.5 bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none text-white font-medium transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => (window.location.href = '/admin/documents')}
                disabled={isSubmitting}
              >
                戻る
              </button>
              <button
                className="px-6 py-2.5 bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none flex items-center text-white font-medium transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleSubmitPR}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                    <span>差分を提出中...</span>
                  </>
                ) : (
                  <span>差分を提出する</span>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* 変更されたカテゴリの詳細 */}
        {diffData.document_categories.length > 0 && (
          <div className="mb-10">
            <h2 className="text-xl font-bold mb-4 flex items-center">
              <Folder className="w-5 h-5 mr-2" />
              カテゴリの変更 × {diffData.document_categories.length}
            </h2>
            <div className="space-y-4 mr-20">
              {diffData.document_categories.map(category => {
                const diffInfo = getDiffInfoById(category.id, 'category');
                const originalCategory = originalCats[category.slug];

                return (
                  <div
                    key={category.id}
                    className="bg-gray-900 rounded-lg border border-gray-800 p-6"
                  >
                    <SlugBreadcrumb slug={category.slug} />
                    <SmartDiffValue
                      label="Slug"
                      fieldInfo={getFieldInfo(
                        diffInfo,
                        'slug',
                        category.slug,
                        originalCategory?.slug
                      )}
                    />
                    <SmartDiffValue
                      label="カテゴリ名"
                      fieldInfo={getFieldInfo(
                        diffInfo,
                        'sidebar_label',
                        category.sidebar_label,
                        originalCategory?.sidebar_label
                      )}
                    />
                    <SmartDiffValue
                      label="表示順"
                      fieldInfo={getFieldInfo(
                        diffInfo,
                        'position',
                        category.position,
                        originalCategory?.position
                      )}
                    />
                    <SmartDiffValue
                      label="説明"
                      fieldInfo={getFieldInfo(
                        diffInfo,
                        'description',
                        category.description,
                        originalCategory?.description
                      )}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ドキュメントの変更数表示 */}
        <h2 className="text-xl font-bold mb-4 flex items-center">
          <DocumentDetailed className="w-6 h-6 mr-2" />
          ドキュメントの変更 × {diffData.document_versions.length}
        </h2>

        {/* 変更されたドキュメントの詳細 */}
        {diffData.document_versions.length > 0 && (
          <div className="mb-8 mr-20">
            <div className="space-y-6">
              {diffData.document_versions.map(document => {
                const diffInfo = getDiffInfoById(document.id, 'document');
                const originalDocument = originalDocs[document.slug];

                return (
                  <div
                    key={document.id}
                    className="bg-gray-900 rounded-lg border border-gray-800 p-6"
                  >
                    <SlugBreadcrumb slug={document.slug} />
                    <SmartDiffValue
                      label="Slug"
                      fieldInfo={getFieldInfo(
                        diffInfo,
                        'slug',
                        document.slug,
                        originalDocument?.slug
                      )}
                    />
                    <SmartDiffValue
                      label="タイトル"
                      fieldInfo={getFieldInfo(
                        diffInfo,
                        'sidebar_label',
                        document.sidebar_label,
                        originalDocument?.sidebar_label
                      )}
                    />
                    <SmartDiffValue
                      label="公開設定"
                      fieldInfo={getFieldInfo(
                        diffInfo,
                        'is_public',
                        document.status === 'published',
                        originalDocument?.status === 'published'
                      )}
                    />
                    <SmartDiffValue
                      label="本文"
                      fieldInfo={getFieldInfo(
                        diffInfo,
                        'content',
                        document.content,
                        originalDocument?.content
                      )}
                      isMarkdown
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
