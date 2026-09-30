-- Clarity Terminal: a computer in the bay with the cameras plugged into it,
-- driven from the coach's laptop.
--
-- The terminal computer is never signed in. It opens /terminal/<code> once,
-- grants camera access, and is left running. The code in that link is its
-- whole credential, the same bargain as the guest and share tokens: it can
-- report its own state, answer a preview request, and upload the takes the
-- coach asked it for. It cannot read a single player record.
--
-- One row per terminal carries everything live about it -- what the coach last
-- asked for, what the terminal last said, and the preview handshake. Both
-- sides poll that row; there is no socket to keep alive.
--
-- Service-role only, like every other table here: RLS on, no client policy.

CREATE TABLE IF NOT EXISTS public.camera_terminals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Who the coach's laptop is recording for right now.
  player_id TEXT,
  player_name TEXT,
  lesson_id TEXT,

  -- The coach's latest instruction. A fresh id per press, so the terminal acts
  -- on each one exactly once however often it polls. command_takes is the
  -- saved video id minted for each camera a Start records, in camera order.
  command_id TEXT,
  command TEXT CHECK (command IS NULL OR command IN ('start', 'stop')),
  command_takes JSONB NOT NULL DEFAULT '[]'::jsonb,
  command_at TIMESTAMPTZ,

  -- What the terminal last reported.
  last_seen_at TIMESTAMPTZ,
  acked_command_id TEXT,
  state TEXT NOT NULL DEFAULT 'offline',
  state_message TEXT,
  -- The cameras the terminal has switched on, in order. At most two: one per
  -- side of the coach's compare view.
  cameras JSONB NOT NULL DEFAULT '[]'::jsonb,
  upload_progress INTEGER,

  -- The live preview handshake (WebRTC, whole-SDP, no trickle). The laptop
  -- writes an offer under a fresh session id; the terminal answers it.
  rtc_session_id TEXT,
  rtc_offer TEXT,
  rtc_answer TEXT
);

CREATE INDEX IF NOT EXISTS camera_terminals_account_idx
  ON public.camera_terminals (account_id, created_at);

ALTER TABLE public.camera_terminals ENABLE ROW LEVEL SECURITY;

-- Each camera's recording from one Record press. The id is minted by the
-- server when Record is pressed and is the saved video id the terminal uploads
-- under; the player it is filed under is fixed here at that moment. So
-- switching player on the laptop mid-upload cannot move a finished swing to
-- someone else, and the terminal cannot choose whose recordings it writes into.
CREATE TABLE IF NOT EXISTS public.camera_terminal_takes (
  saved_video_id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES public.camera_terminals (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  lesson_id TEXT,
  -- Which side of the compare view this camera fills: the first camera left,
  -- the second right.
  side TEXT NOT NULL DEFAULT 'left' CHECK (side IN ('left', 'right')),
  camera_label TEXT,
  status TEXT NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording', 'uploading', 'ready', 'failed')),
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS camera_terminal_takes_terminal_idx
  ON public.camera_terminal_takes (terminal_id, created_at DESC);

ALTER TABLE public.camera_terminal_takes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.camera_terminals IS
  'Clarity Terminal: an unattended camera computer driven from the coach app. code is the terminal''s only credential. Service-role only; RLS enabled with no client policy by design.';

COMMENT ON TABLE public.camera_terminal_takes IS
  'One row per remote recording. saved_video_id is minted server-side and the player is fixed at Record time.';

NOTIFY pgrst, 'reload schema';
