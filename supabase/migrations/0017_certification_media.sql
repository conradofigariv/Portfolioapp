-- Lets a certification carry one uploaded file (the certificate itself — a
-- PDF or a photo of it), stored like every other media row and keyed by the
-- certification's own block-list item id in target_id.
--
-- No new limit rule is needed: enforce_media_limits() (0001) already falls
-- through to `else 1` for any kind it doesn't name explicitly, which is
-- exactly the "one file per certification" container this is meant to be.
alter table public.portfolio_media drop constraint portfolio_media_kind_check;

alter table public.portfolio_media add constraint portfolio_media_kind_check
  check (kind in ('project', 'chapter', 'portrait', 'background_video', 'cv', 'certification'));
