export const SWIPE_STEER_SECONDS = 0.72;
export const SWIPE_JUMP_SECONDS = 0.4;

export function swipeDirection(dx, dy, surfaceHeight) {
  const threshold = Math.min(36, Math.max(20, surfaceHeight * 0.055));
  const x = Math.abs(dx);
  const y = Math.abs(dy);
  if (x >= threshold && x > y) return dx < 0 ? "left" : "right";
  if (dy <= -threshold && y >= x) return "jump";
  return null;
}
