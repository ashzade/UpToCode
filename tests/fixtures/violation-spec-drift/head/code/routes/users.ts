import { Router, Request, Response } from 'express';

const router = Router();

// GET /api/users/:id/profile
router.get('/:id/profile', async (req: Request, res: Response) => {
  const user = await db.users.findById(req.params.id);
  return res.json(user);
});

// PUT /api/users/:id/profile
// BUG: Missing RULE_SEC_01 guard — any actor can set is_pro
router.put('/:id/profile', async (req: Request, res: Response) => {
  const { display_name, email, is_pro } = req.body;
  // RULE_SEC_01 violated: is_pro update not restricted to actor:System
  await db.users.update(req.params.id, { display_name, email, is_pro });
  return res.json({ success: true });
});

export default router;
