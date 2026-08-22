// (o==================================================================o)
//   #region REALMS
// (o-----------------------------------------------------------\/-----o)

export type NoxRealm = "internal" | "public";

export const NOX_REALM_PATH: Record<NoxRealm, string> = {
  internal: "i",
  public: "p",
};

export function realm_from_path_segment(
  segment: string | null | undefined,
): NoxRealm | null {
  if (segment === "i" || segment === "internal") {
    return "internal";
  }
  if (segment === "p" || segment === "public") {
    return "public";
  }
  return null;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion REALMS
// (o==================================================================o)
