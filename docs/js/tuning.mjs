/*
 * Egg Mama — every tuning number in one place.
 *
 * Units: the world is measured in "u". The playfield is always VIEW_H (360 u)
 * tall, y grows DOWNWARD, and one u is about one CSS pixel on a phone held
 * sideways. Times are seconds, speeds are u/s, accelerations are u/s².
 *
 * Children play this game, so Ben will retune after playtesting. Change numbers
 * HERE, never inline in other modules. If you change anything that affects
 * reach (gravity, jumpSpeed, cruise, coyote, buffer) run `node --test`: the
 * level generator and the bot tests are built on these values.
 */

export const T = Object.freeze({
  // ── simulation clock ─────────────────────────────────────────────────
  step: 1 / 120,            // fixed simulation step
  maxFrame: 0.1,            // longest real frame we will catch up on (then we drop time)

  // ── the playfield ────────────────────────────────────────────────────
  viewH: 360,               // world units visible vertically. Never changes: the horizon stays put.
  viewMinW: 560,            // if the screen is narrower than this (tablet, 4:3) we show extra sky instead of squeezing
  groundY: 292,             // the usual height of the main route's ground
  killY: 420,               // below this Mama has fallen out of the world
  mamaScreenX: 0.30,        // Mama sits this far across the screen (0..1) so more of the future than the past is visible
  lookAhead: 0.07,          // extra camera lead (fraction of view width) while pushing ahead

  // ── Mama ─────────────────────────────────────────────────────────────
  mamaHalfW: 13,            // hurtbox half width (art is a little bigger: forgiving)
  mamaH: 38,                // hurtbox height; (x, y) is the bottom-centre = feet
  footHalfW: 11,            // half width used to find ground under her
  edgeForgive: 7,           // landing counts if her feet centre is within this of a platform's end
  stepUp: 10,               // a solid wall edge this low is stepped onto instead of blocking

  // ── horizontal motion ────────────────────────────────────────────────
  cruise: 110,              // the gentle default roll
  push: 178,                // swipe right: push ahead
  back: 64,                 // swipe left: speed while backing up (negative direction)
  steerSeconds: 0.8,        // how long one steering swipe lasts before the roll returns
  keyHoldSteer: true,       // keyboard left/right steer while held
  groundAccel: 620,         // u/s² toward the target speed on normal ground
  iceAccel: 70,             // on ice: slow to change speed (long stopping distance)
  airAccel: 260,            // steering while airborne
  rollInSeconds: 1.1,       // ease-in after start / resume / respawn (INPUT-1)
  rollInStart: 0.25,        // fraction of cruise Mama has at the instant play begins

  // ── vertical motion ──────────────────────────────────────────────────
  gravity: 1500,
  jumpSpeed: 560,           // apex = 104 u, airtime 0.75 s on flat ground
  maxFall: 900,
  coyote: 0.12,             // grace after leaving an edge
  buffer: 0.16,             // a jump asked this early before landing still happens
  stompBounce: 420,         // hop after stomping an enemy
  stompJump: 600,           // ...if jump was requested around the stomp
  springSpeed: 820,         // springs launch her much higher (apex 224 u)

  // ── damage and recovery ──────────────────────────────────────────────
  invulnHit: 1.7,           // recovery window after a survivable hit
  invulnRespawn: 2.0,       // after a survivable fall returns her to the checkpoint
  knockVx: -70,             // a hit pushes her back a little...
  knockVy: -260,            // ...and up
  hitSteerLock: 0.35,       // swipes are ignored while she's being knocked back
  deadSeconds: 1.0,         // time before the retry screen may appear

  // ── pickups ──────────────────────────────────────────────────────────
  eggRadius: 11,
  goldRadius: 15,
  mamaPickupRadius: 17,     // Mama's generous pickup circle (centred on her body)
  magnetSeconds: 8,
  magnetRadius: 150,
  magnetPull: 320,
  maxFlock: 5,
  shieldMax: 1,

  // ── points ───────────────────────────────────────────────────────────
  scoreEgg: 10,
  scoreGold: 50,
  scoreStomp: 25,
  scoreChapter: 100,
  scoreBeacon: 500,

  // ── flock followers ──────────────────────────────────────────────────
  flockDelay: 0.2,          // seconds behind Mama for the first duckling
  flockGap: 0.17,           // extra seconds for each following duckling
  flockMinSpacing: 19,      // ducklings never overlap closer than this (u)
  historyRate: 60,          // trail samples per second

  // ── platforms ────────────────────────────────────────────────────────
  crumbleDelay: 0.55,       // standing on a cracked ledge this long and it gives way
  crumbleRespawn: 3.2,      // a crumbled ledge reforms after this many seconds
  crumbleRumble: 0.2,       // it visibly shakes for this long before it drops

  // ── level pacing bands (seconds, clean main route at cruise) ─────────
  paceBands: Object.freeze({ early: [60, 90], middle: [90, 120], late: [120, 150] }),

  // ── generator limits (levelgen respects these so every jump is fair) ─
  // Flat-ground jump at cruise covers about  jumpSpeed*2/gravity*cruise = 82 u.
  maxGapEasy: 52,
  maxGapHard: 70,           // never beyond this, any chapter, any circuit
  minLanding: 70,           // narrowest landing platform for a required jump
  minWindow: 0.16,          // narrowest allowed takeoff window (s) for any required jump
});

/** Flat-ground jump distance at a given forward speed (no landing height change). */
export const jumpDistance = (speed = T.cruise) => (2 * T.jumpSpeed / T.gravity) * speed;
/** Apex height of a normal jump. */
export const jumpApex = () => (T.jumpSpeed * T.jumpSpeed) / (2 * T.gravity);

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
