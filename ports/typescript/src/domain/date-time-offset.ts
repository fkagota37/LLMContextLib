// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

const timestamp = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,7}))?(Z|([+-])(\d\d):(\d\d))$/;
const minimum = -621355968000000000n;
const maximum = 2534023007999999999n;
const ticksPerMillisecond = 10_000n;

function checked(ticks: bigint): bigint {
  if (ticks < minimum || ticks > maximum) throw new RangeError('Timestamp is outside the DateTimeOffset range.');
  return ticks;
}

export function timestampTicks(value: string | number | Date): bigint {
  if (typeof value !== 'string') {
    const milliseconds = value instanceof Date ? value.getTime() : value;
    if (!Number.isSafeInteger(milliseconds)) throw new RangeError('Clock must return finite epoch milliseconds or a timestamp.');
    return checked(BigInt(milliseconds) * ticksPerMillisecond);
  }

  const match = timestamp.exec(value);
  if (!match) throw new TypeError('Expected an ISO timestamp with an explicit UTC offset and at most seven fractional digits.');
  const [, local, fraction = '', zone, sign, hours = '0', minutes = '0'] = match;
  const millis = Date.parse(`${local}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== local) {
    throw new RangeError('Invalid calendar timestamp.');
  }
  const localTicks = checked(BigInt(millis) * ticksPerMillisecond + BigInt(fraction.padEnd(7, '0')));
  const offsetMinutes = Number(hours) * 60 + Number(minutes);
  if (Number(minutes) >= 60 || offsetMinutes > 14 * 60) throw new RangeError('Invalid UTC offset.');
  const offsetTicks = BigInt(offsetMinutes) * 60_000n * ticksPerMillisecond;
  return checked(zone === 'Z' ? localTicks : sign === '+' ? localTicks - offsetTicks : localTicks + offsetTicks);
}

export function formatTimestampInvariant(value: string): string {
  timestampTicks(value);
  const offset = value.endsWith('Z') || value.endsWith('-00:00') ? '+00:00' : value.slice(-6);
  return `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)} ${value.slice(11, 19)} ${offset}`;
}
