-- A photo's focal point (0004) is one CSS object-position shared by every
-- box it's ever displayed in. That breaks down once the same photo renders
-- inside boxes of two different shapes on different breakpoints (e.g. the
-- hero portrait: a square box on mobile, a tall rectangle on desktop) — one
-- position can't be right for both. This adds a second, optional focal point
-- just for the mobile box; when it's null, mobile falls back to the
-- original `position` column exactly as it always has.
alter table public.portfolio_media add column position_mobile text;
