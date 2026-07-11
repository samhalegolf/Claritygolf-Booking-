alter table public.video_transfer_sessions
  drop constraint if exists video_transfer_sessions_status_check;

alter table public.video_transfer_sessions
  add constraint video_transfer_sessions_status_check
  check (
    status in (
      'preparing',
      'session-created',
      'uploading',
      'paused',
      'verifying',
      'ready',
      'failed',
      'cancelled',
      'expired'
    )
  );

drop index if exists public.video_transfer_sessions_one_active_saved_video;

create unique index if not exists video_transfer_sessions_one_active_saved_video
  on public.video_transfer_sessions (account_id, saved_video_id)
  where status in ('preparing', 'session-created', 'uploading', 'paused', 'verifying');

comment on constraint video_transfer_sessions_status_check on public.video_transfer_sessions is
  'session-created means Google returned a resumable upload URL, but no video chunk has begun yet.';
