//   #region TAG TYPES

export type NoxTagScope = "global" | "kirlet";

export interface NoxTag {
  id: string;
  name: string;
  description?: string | null;
  color: string;
  icon?: string | null;
  scope: NoxTagScope;
  /** `nox` or `kirlet-<slug>` when scope is kirlet */
  owner: string;
  is_active: boolean;
}

//   #endregion TAG TYPES
