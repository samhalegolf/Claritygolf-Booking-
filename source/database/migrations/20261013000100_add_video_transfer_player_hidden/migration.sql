-- A player removing a cloud video from their own portal list.
--
-- The video lives in the coach's Drive, so a player can never delete it --
-- only stop seeing it. The coach's view, the Drive file and the transfer row
-- are all untouched; this one timestamp is the whole effect.

ALTER TABLE public.video_transfer_sessions
  ADD COLUMN IF NOT EXISTS player_hidden_at TIMESTAMPTZ;

COMMENT ON COLUMN public.video_transfer_sessions.player_hidden_at IS
  'Set when the player removes this video from their portal list. Hides it from the player only; the coach and Drive are unaffected.';

NOTIFY pgrst, 'reload schema';
