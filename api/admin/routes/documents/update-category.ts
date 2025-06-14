import { Router, Request, Response } from 'express';
import { HTTP_STATUS, API_ERRORS } from '../../../const/errors';
import { db } from '@site/src/lib/db';
import { getAuthenticatedUser } from '../../utils/auth';
import { initBranchSnapshot } from '../../utils/git';
import { getCategoryIdFromPath } from '@site/api/utils/document-category';

// Request型の拡張
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: number;
        email: string;
      };
    }
  }
}

interface UpdateCategoryRequest {
  originalSlug: string;
  slug: string;
  sidebarLabel: string;
  position?: number;
  description?: string;
}

const router = Router();

/**
 * カテゴリ更新API
 *
 * 既存のカテゴリを更新します。
 * ブランチ管理のため、既存レコードを論理削除し、新規レコードを作成します。
 *
 * リクエスト:
 * PUT /api/admin/documents/update-category
 * body: {
 *   originalSlug: string,
 *   slug: string,
 *   sidebarLabel: string,
 *   position?: number,
 *   description?: string
 * }
 *
 * レスポンス:
 * 成功: { success: true, slug: string, label: string }
 * 失敗: { error: string }
 */
router.put('/update-category', async (req: Request, res: Response) => {
  try {
    const sessionId = req.cookies.sid;

    // 1. 認証ユーザーか確認
    if (!sessionId) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        error: API_ERRORS.AUTH.NO_SESSION,
      });
    }

    const loginUser = await getAuthenticatedUser(sessionId);
    if (!loginUser) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        error: API_ERRORS.AUTH.INVALID_SESSION,
      });
    }

    const { originalSlug, slug, sidebarLabel, position, description } = req.body as UpdateCategoryRequest;

    // バリデーション
    if (!originalSlug || typeof originalSlug !== 'string') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'originalSlug is required and must be a string',
      });
    }

    if (!slug || typeof slug !== 'string') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'slug is required and must be a string',
      });
    }

    // 重複チェック
    const categoryId = await getCategoryIdFromPath(slug);
        if (categoryId) {
          return res.status(HTTP_STATUS.CONFLICT).json({
            error: 'slugが重複しています',
          });
        }


    if (!sidebarLabel || typeof sidebarLabel !== 'string') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'sidebarLabel is required and must be a string',
      });
    }

    if (position !== undefined && typeof position !== 'number') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'position must be a number',
      });
    }

    if (description !== undefined && typeof description !== 'string') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'description must be a string',
      });
    }

    // 2. ユーザーのアクティブブランチ確認
    const activeBranch = await db.execute({
      sql: 'SELECT id, branch_name FROM user_branches WHERE user_id = ? AND is_active = ? AND pr_status = ?',
      args: [loginUser.userId, 1, 'none'],
    });

    let userBranchId;
    const now = new Date();

    if (activeBranch.rows.length > 0) {
      // 存在する場合：そのブランチのuser_branch_idを使用
      userBranchId = activeBranch.rows[0].id;
    } else {
      // 存在しない場合：新規ブランチを作成
      await initBranchSnapshot(loginUser.userId, loginUser.email);

      const newBranch = await db.execute({
        sql: 'SELECT id FROM user_branches WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1',
        args: [loginUser.userId],
      });

      if (newBranch.rows.length === 0) {
        throw new Error('ブランチの作成に失敗しました');
      }

      userBranchId = newBranch.rows[0].id;
    }

    // 3. リクエストのslugから既存カテゴリのレコードを再帰的に取得
    const existingCategoryId = await getCategoryIdFromPath(originalSlug);
    
    if (!existingCategoryId) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        error: '更新対象のカテゴリが見つかりません',
      });
    }

    // 既存カテゴリの詳細情報を取得
    const existingCategory = await db.execute({
      sql: 'SELECT * FROM document_categories WHERE id = ? AND is_deleted = 0',
      args: [existingCategoryId],
    });

    if (existingCategory.rows.length === 0) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        error: '更新対象のカテゴリが見つかりません',
      });
    }

    const categoryData = existingCategory.rows[0];

    // 4. 既存カテゴリのレコードを論理削除
    await db.execute({
      sql: 'UPDATE document_categories SET is_deleted = 1, updated_at = ? WHERE id = ?',
      args: [now, existingCategoryId],
    });

    // category_positionの重複処理を追加する

    // 5. ブランチ管理のためにリクエストの編集内容をもとに新規レコードを挿入
    const categoryResult = await db.execute({
      sql: `INSERT INTO document_categories (
        slug, sidebar_label, position, description, 
        status, last_edited_by, user_branch_id, parent_id,
        created_at, updated_at, is_deleted
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [
        slug,
        sidebarLabel,
        position || categoryData.position,
        description || categoryData.description,
        loginUser.email,
        userBranchId,
        categoryData.parent_id,
        now,
        now,
        0,
      ],
    });

    const newCategoryId = categoryResult.rows[0].id;

    return res.status(HTTP_STATUS.OK).json({
      success: true,
      slug: slug,
      label: sidebarLabel,
      id: newCategoryId,
    });
  } catch (error) {
    console.error('カテゴリ更新エラー:', error);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: 'Failed to update category',
    });
  }
});

export const updateCategoryRouter = router; 