export const API_CONFIG = {
  // 環境に基づいたベースURLの設定
  BASE_URL: 'http://localhost:3001/api', // APIサーバーの絶対URLを指定

  TIMEOUT: 10000,

  ENDPOINTS: {
    SIGNUP: '/admin/signup',
    LOGIN: '/admin/login',
    DOCUMENTS: {
      CREATE_FOLDER: '/admin/documents/create-folder',
      GET_FOLDERS: '/admin/documents/folders',
    },
    USERS: {
      GET_ALL: '/admin/users',
    },
  },
};
