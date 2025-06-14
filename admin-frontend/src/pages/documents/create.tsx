import { useState, useEffect } from 'react';
import AdminLayout from '@/components/admin/layout';
import { useSessionCheck } from '@/hooks/useSessionCheck';
import TiptapEditor from '@/components/admin/editor/TiptapEditor';
import { apiClient } from '@/components/admin/api/client';
import { API_CONFIG } from '@/components/admin/api/config';

// ユーザー型定義を追加
interface User {
  id: string;
  email: string;
}

// エラー型の定義を追加
interface ApiError {
  message?: string;
}

export default function CreateDocumentPage(): JSX.Element {
  const { isLoading } = useSessionCheck('/login', false);

  const [label, setLabel] = useState('');
  const [content, setContent] = useState('');
  const [publicOption, setPublicOption] = useState('公開する');
  const [folders, setFolders] = useState<string[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [slug, setSlug] = useState('');
  const [fileOrder, setFileOrder] = useState('');
  const [invalidSlug, setInvalidSlug] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredUsers, setFilteredUsers] = useState<User[]>([]);

  // 予約語やルーティングで使用される特殊パターン
  const reservedSlugs = ['create', 'edit', 'new', 'delete', 'update'];

  // slugのバリデーション関数
  const validateSlug = (value: string) => {
    // 空の場合はエラーなし（必須チェックは別で行う）
    if (!value.trim()) {
      setInvalidSlug(null);
      return;
    }

    // 予約語チェック
    if (reservedSlugs.includes(value.toLowerCase())) {
      setInvalidSlug(`"${value}" は予約語のため使用できません`);
      return;
    }

    // URLで問題になる文字をチェック
    if (!/^[a-z0-9-]+$/i.test(value)) {
      setInvalidSlug('英数字とハイフン(-)のみ使用できます');
      return;
    }

    setInvalidSlug(null);
  };

  // slugの変更ハンドラー
  const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSlug(value);
    validateSlug(value);
  };

  useEffect(() => {
    // フォルダ一覧を取得
    const fetchFolders = async () => {
      try {
        const response = await apiClient.get('/admin/documents/folders');
        console.log('フォルダ取得レスポンス:', response);
        if (response.folders) {
          setFolders(response.folders);
        }
      } catch (err) {
        console.error('フォルダ取得エラー:', err);
      } finally {
        setFoldersLoading(false);
      }
    };

    fetchFolders();

    // ユーザー一覧を取得
    const fetchUsers = async () => {
      try {
        const response = await apiClient.get(API_CONFIG.ENDPOINTS.USERS.GET_ALL);
        if (response.users) {
          setUsers(response.users);
          setFilteredUsers(response.users);
        }
      } catch (err) {
        console.error('ユーザー取得エラー:', err);
      } finally {
        setUsersLoading(false);
      }
    };

    fetchUsers();
  }, []);

  useEffect(() => {
    // 検索クエリに基づいてユーザーをフィルタリング
    if (searchQuery) {
      const filtered = users.filter(user =>
        user.email.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredUsers(filtered);
    } else {
      setFilteredUsers(users);
    }
  }, [searchQuery, users]);

  const handleEditorChange = (html: string) => {
    setContent(html);
  };

  const handleSave = async () => {
    try {
      if (!label) {
        alert('タイトルを入力してください');
        return;
      }

      const queryParams = new URLSearchParams(window.location.search);
      const category = queryParams.get('category');

      // ドキュメント作成APIを呼び出す
      const response = await apiClient.post(API_CONFIG.ENDPOINTS.DOCUMENTS.CREATE_DOCUMENT, {
        category,
        label,
        content,
        isPublic: publicOption === '公開する', // 公開設定を真偽値に変換
        slug,
        fileOrder,
      });

      if (response.success) {
        alert('ドキュメントが作成されました');
        // 成功したら一覧ページに戻る
        window.location.href = `/admin/documents/${category}`;
      } else {
        throw new Error(response.message || '不明なエラーが発生しました');
      }
    } catch (error: unknown) {
      console.error('ドキュメント作成エラー:', error);
      const apiError = error as ApiError;
      alert(`ドキュメントの作成に失敗しました: ${apiError.message || '不明なエラー'}`);
    }
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

  return (
    <AdminLayout title="ドキュメント作成">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-4">ドキュメント作成</h1>
          <div className="flex items-center gap-4 mb-6">
            <button
              className="bg-gray-900 rounded-xl w-12 h-12 flex items-center justify-center border border-gray-700"
              onClick={() => window.history.back()}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          </div>

          <div className="mb-6">
            <label className="block mb-2 font-bold">Slug</label>
            <input
              type="text"
              value={slug}
              onChange={handleSlugChange}
              className={`w-full p-2.5 border ${invalidSlug ? 'border-red-500' : 'border-gray-700'} rounded bg-transparent text-white`}
              placeholder="slugを入力してください"
            />
            {invalidSlug && <p className="mt-1 text-red-500 text-sm">{invalidSlug}</p>}
          </div>

          <div className="mb-6">
            <label className="block mb-2 font-bold">表示順序</label>
            <input
              type="number"
              value={fileOrder}
              onChange={e => setFileOrder(e.target.value)}
              className="w-full p-2.5 border border-gray-700 rounded bg-transparent text-white"
              placeholder="表示順序を入力してください"
            />
          </div>

          <div className="mb-6">
            <label className="block mb-2 font-bold">タイトル</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="w-full p-2.5 border border-gray-700 rounded bg-transparent text-white"
              placeholder="タイトルを入力してください"
            />
          </div>

          <div className="mb-6">
            <label className="block mb-2 font-bold">公開設定</label>
            <div className="relative">
              <select
                value={publicOption}
                onChange={e => setPublicOption(e.target.value)}
                className="w-full p-2.5 border border-gray-700 rounded bg-transparent text-white appearance-none pr-10"
              >
                <option value="公開する">公開する</option>
                <option value="公開しない">公開しない</option>
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                <svg
                  className="w-5 h-5 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M19 9l-7 7-7-7"
                  ></path>
                </svg>
              </div>
            </div>
          </div>

          <div className="gap-6 mt-8">
            <div>
              <label className="block mb-2 font-bold">本文</label>
              <div className="w-full p-2.5 border border-gray-700 rounded bg-black text-white min-h-72">
                <TiptapEditor
                  initialContent=""
                  onChange={handleEditorChange}
                  placeholder="ここにドキュメントを作成してください"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center gap-4 mt-8">
            <button
              className="px-4 py-2 bg-[#3832A5] text-white rounded hover:bg-opacity-80 border-none w-45"
              onClick={handleSave}
              disabled={!!invalidSlug}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
