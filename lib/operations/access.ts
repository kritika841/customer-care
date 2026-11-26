import {
  requireApiUser,
  isSameOrigin,
  isAdmin,
  isSupportManager,
  isSupportRole,
  type DashboardUser,
} from "../auth/access";
import { HttpError } from "../http";

export const manager = (u: DashboardUser) => isSupportManager(u);
export const admin = (u: DashboardUser) => isAdmin(u);

export async function access(
  request?: Request,
  area: "inventory" | "support" = "support",
) {
  const a = await requireApiUser(request);
  if (a.response) throw new HttpError(401, "Please sign in to continue");
  if (request && request.method !== "GET" && !isSameOrigin(request))
    throw new HttpError(403, "Invalid request origin");
  if (area === "support" && !isSupportRole(a.user))
    throw new HttpError(
      403,
      "A support role is required. Ask an administrator to assign one in Manage users.",
    );
  return a.user;
}
