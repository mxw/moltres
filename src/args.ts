/*
 * Argument types and parsers.
 */

export enum Arg {
  STR = 1,
  INT,
  VARIADIC,
  MONTHDAY,
  HOURMIN,
  TIMER,
  TIER,
  BOSS,
};

/*
 * Invalid argument object.
 */
export class InvalidArg {
  constructor(readonly arg: any) {}
}

///////////////////////////////////////////////////////////////////////////////
// Time args.

/*
 * Return a Date for the current time.
 */
export function get_now(): Date {
  return new Date(Date.now());
}

/*
 * Parse a date given by MM/DD as a Date object.
 */
export function parse_month_day(date: string): Date {
  const matches = date.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (matches === null) return null;

  const [, month_, day_] = matches;
  const [month, day] = [parseInt(month_), parseInt(day_)];

  const now = get_now();

  return new Date(
    now.getFullYear() + +(now.getMonth() === 12 && month === 1),
    month - 1,
    day
  );
}

/*
 * Text-based representation of a time of day.
 */
export type TimeSpec = {
  hours: number;
  mins: number;
  am_pm?: 'am' | 'pm'
} | 'hatch'

/*
 * Raid countdown timer.
 */
export type Timer = {
  mins: number;
  secs: number;
}

/*
 * Parse a time given by HH:MM[am|pm].
 */
export function parse_hour_minute(time: string): TimeSpec | null {
  if (time === 'hatch') return time;

  const matches = time.match(/^(\d{1,2})[:.](\d\d)([aApP][mM])?$/);
  if (matches === null) return null;

  const [, hours_, mins_, am_pm_] = matches;

  const [hours, mins] = [parseInt(hours_), parseInt(mins_)];
  if (hours >= 24 || mins >= 60) return null;

  const am_pm = am_pm_?.toLowerCase() as 'am' | 'pm';

  return {hours, mins, am_pm};
}

/*
 * Extract the minutes and seconds from a raid countdown timer.
 */
export function parse_timer(timer: string): Timer | null {
  const matches = timer.match(/^(\d{1,2}[:.])?(\d{1,2})[:.](\d\d)$/);
  if (matches === null) return null;

  const [, hrs_ = '0', mins_, secs_] = matches;
  const [hrs, mins, secs] = [parseInt(hrs_), parseInt(mins_), parseInt(secs_)];

  if (secs >= 60) return null;

  return {mins: 60 * hrs + mins, secs};
}

///////////////////////////////////////////////////////////////////////////////
// Boss args.
