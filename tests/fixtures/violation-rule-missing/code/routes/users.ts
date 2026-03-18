import { Router, Request, Response } from 'express';

const router = Router();

// POST /api/users/:id/unlock
// BUG: Missing session age check — RULE_SEC_01 violated
router.post('/:id/unlock', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { unlock_token } = req.body;

  if (!unlock_token) {
    return res.status(400).json({ error: 'Invalid unlock token.' });
  }

  // Missing: check that session was created within the last 30 minutes
  // Required by RULE_SEC_01: Session.created_at > NOW() - INTERVAL(30, minutes)

  await db.users.update(id, { status: 'ACTIVE', unlock_token: null });
  return res.json({ success: true });
});

export default router;
