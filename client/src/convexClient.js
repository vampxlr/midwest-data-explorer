import { ConvexReactClient } from "convex/react";

const url = import.meta.env.VITE_CONVEX_URL;

// null when VITE_CONVEX_URL is not set (legacy mode using Express API only)
export const convex = url ? new ConvexReactClient(url) : null;
