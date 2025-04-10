import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import { signupRouter } from './routes/signup';
import { loginRouter } from './routes/login';
import { middleware } from './routes/middleware';
import { sessionService } from '../../src/services/sessionService';

// Expressアプリの初期化
const app = express();

// ミドルウェアの設定
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? 'https://yourdomain.com'
    : 'http://localhost:3000',
  credentials: true // クッキーを含むリクエストを許可
}));
app.use(bodyParser.json());
app.use(cookieParser());

// その他のミドルウェアを設定
middleware.forEach(mw => app.use(mw));

// ルートの登録
app.use('/api/admin', signupRouter);
app.use('/api/admin', loginRouter);

// セッション確認
app.get('/api/auth/session', async (req, res) => {
  const sessionId = req.cookies.sid;
  
  if (!sessionId) {
    return res.json({
      authenticated: false,
      message: 'セッションがありません'
    });
  }
  
  try {
    const user = await sessionService.getSessionUser(sessionId);
    
    if (!user) {
      return res.json({
        authenticated: false,
        message: 'セッションが無効または期限切れです'
      });
    }
    
    return res.json({
      authenticated: true,
      user
    });
  } catch (error) {
    console.error('セッション確認エラー:', error);
    return res.status(500).json({
      authenticated: false,
      error: 'セッション確認中にエラーが発生しました'
    });
  }
});

// 定期的に期限切れセッションをクリーンアップ
setInterval(async () => {
  try {
    await sessionService.cleanupSessions();
    console.log('期限切れセッションをクリーンアップしました');
  } catch (error) {
    console.error('セッションクリーンアップエラー:', error);
  }
}, 90 * 60 * 60 * 1000); // 90日ごとに実行

// サーバーの起動
const PORT = process.env.API_PORT || 3001;

function startServer() {
  app.listen(PORT, () => {
    console.log(`APIサーバー実行中: http://localhost:${PORT}`);
  });
}

// エントリーポイント
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export { app, startServer };
