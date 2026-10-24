// Input schemas shared by every platform's tools. Some models send scalars as strings ("25", "true"); these accept
// them rather than fail the call.

import { z } from "zod";

/** A number that also accepts numeric strings. Unlike z.coerce.number(), "", null and true stay invalid instead of becoming 0 or 1. */
export const numeric = (schema: z.ZodNumber = z.number()) => z.preprocess((value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value), schema);

/** A boolean that also accepts "true" and "false"; z.coerce.boolean() would read "false" as true. */
export const flag = () => z.preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean());
