import type { z } from "zod";
import {
  memoryAttribution,
  memoryMutationResult,
  memoryToken,
  memoryView,
} from "./contract";

export type MemoryAttribution = z.infer<typeof memoryAttribution>;
export type MemoryToken = z.infer<typeof memoryToken>;
export type MemoryView = z.infer<typeof memoryView>;
export type MemoryMutationResult = z.infer<typeof memoryMutationResult>;
