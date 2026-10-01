export const IST = 'Asia/Kolkata';

/** Format a UTC instant for display in India. Storage is always UTC. */
export function formatIST(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

export const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
export const addMinutes = (d: Date, m: number) => addSeconds(d, m * 60);

/** YYYY-MM-DD of the given instant in IST. */
export function istDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(d);
}
