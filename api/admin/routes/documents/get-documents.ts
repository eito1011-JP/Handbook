import { Router, Request, Response } from 'express';
import { HTTP_STATUS, API_ERRORS } from '../../../const/errors';
import { sessionService } from '../../../../src/services/sessionService';
import { db } from '../../../../src/lib/db';
import { getCategoryIdFromPath } from '../../../utils/document-category';

// 型定義
interface DocumentResponse {
  sidebarLabel: string | null;
  slug: string | null;
  isPublic: boolean;
  status: string;
  lastEditedBy: string | null;
  fileOrder: number | null;
}

interface CategoryResponse {
  slug: string;
  sidebarLabel: string;
}

interface GetDocumentsResponse {
  documents: DocumentResponse[];
  categories: CategoryResponse[];
}

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

const router = Router();

// データベースクエリ
const queries = {
  getDefaultCategory: async (): Promise<number | null> => {
    const result = await db.execute({
      sql: 'SELECT id FROM document_categories WHERE slug = ?',
      args: ['uncategorized'],
    });
    return result.rows[0]?.id ? Number(result.rows[0].id) : null;
  },

  getCategoryBySlug: async (slug: string, parentId: number | null): Promise<number | null> => {
    const result = await db.execute({
      sql: 'SELECT id FROM document_categories WHERE slug = ? AND parent_id IS ?',
      args: [slug, parentId],
    });
    return result.rows[0]?.id ? Number(result.rows[0].id) : null;
  },

  getSubCategories: async (categoryId: number | null, userBranchId: number | null) => {
    const result = await db.execute({
      sql: `
        SELECT slug, sidebar_label
        FROM document_categories
        WHERE parent_id = ?
          AND user_branch_id = ?
        ORDER BY position ASC
      `,
      args: [categoryId, userBranchId],
    });
    return result.rows;
  },

  getDocuments: async (categoryId: number | null, userBranchId: number | null) => {
    const result = await db.execute({
      sql: `
        SELECT 
          sidebar_label,
          slug,
          is_public,
          status,
          last_edited_by,
          file_order
        FROM document_versions 
        WHERE category_id = ? 
          AND is_deleted = 0 
          AND (
            status IN ('pushed', 'merged')
            OR (user_branch_id = ? AND status = 'draft')
          )
          AND is_deleted = 0
      `,
      args: [categoryId, userBranchId],
    });
    return result.rows;
  },
};

// データ変換関数
const transformers = {
  toDocumentResponse: (row: any): DocumentResponse => ({
    sidebarLabel: row.sidebar_label as string | null,
    slug: row.slug as string | null,
    isPublic: Boolean(row.is_public),
    status: row.status as string,
    lastEditedBy: row.last_edited_by as string | null,
    fileOrder: row.file_order as number | null,
  }),

  toCategoryResponse: (row: any): CategoryResponse => ({
    slug: row.slug as string,
    sidebarLabel: row.sidebar_label as string,
  }),
};

router.get('/', async (req: Request, res: Response) => {
  try {
    // 認証チェック
    const sessionId = req.cookies.sid;
    const loginUser = await sessionService.getSessionUser(sessionId);

    if (!loginUser) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        error: API_ERRORS.AUTH.NO_SESSION,
      });
    }

    // クエリパラメータからslugを取得
    const slugParam = (req.query.slug as string) || '';

    // カテゴリパスの取得と処理
    const categoryPath = slugParam.split('/').filter(segment => segment.length > 0);

    const currentCategoryId = await getCategoryIdFromPath(categoryPath);

    // アクティブなブランチを取得
    const activeBranch = await db.execute({
      sql: 'SELECT id FROM user_branches WHERE user_id = ? AND is_active = ? AND pr_status = ?',
      args: [loginUser.userId, 1, 'none'],
    });

    let userBranchId;
    if (activeBranch.rows.length > 0) {
      userBranchId = activeBranch.rows[0]?.id;
    } else {
      userBranchId = null;
    }

    // データ取得
    const [subCategories, documents] = await Promise.all([
      queries.getSubCategories(currentCategoryId, userBranchId),
      queries.getDocuments(currentCategoryId, userBranchId),
    ]);

    // ソート処理
    const sortedDocuments = documents
      .map(transformers.toDocumentResponse)
      .filter(doc => doc.fileOrder !== null)
      .sort((a, b) => a.fileOrder! - b.fileOrder!);

    const sortedCategories = subCategories
      .map(transformers.toCategoryResponse)
      .filter(cat => {
        const originalCat = subCategories.find(c => c.slug === cat.slug);
        return originalCat?.position !== null;
      })
      .sort((a, b) => {
        const posA = Number(subCategories.find(cat => cat.slug === a.slug)?.position);
        const posB = Number(subCategories.find(cat => cat.slug === b.slug)?.position);
        return posA - posB;
      });

    // レスポンスの構築
    const response: GetDocumentsResponse = {
      documents: sortedDocuments,
      categories: sortedCategories,
    };

    return res.status(HTTP_STATUS.OK).json(response);
  } catch (error) {
    console.error('ドキュメント一覧取得エラー:', error);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: API_ERRORS.SERVER.INTERNAL_ERROR,
    });
  }
});

export const getDocumentsRouter = router;
