// src/capabilities/index.ts
import type { Capability } from './contract.js';
import { structReadCapability } from './struct-read.js';
import { memChangedAllCapability } from './mem-changed-all.js';
import { memReadRangeCapability } from './mem-read-range.js';
// Add one import per new capability, then one entry below. Nothing else changes.

export const CAPABILITIES: Capability[] = [
  structReadCapability,
  memChangedAllCapability,
  memReadRangeCapability,
];
