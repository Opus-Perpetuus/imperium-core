// (o==================================================================o)
//   #region AUTH TYPES
// (o-----------------------------------------------------------\/-----o)

export interface NoxAuthUser {
  id: string;
  email: string;
  name: string;
  is_active: boolean;
  is_admin: boolean;
  group_ids: string[];
  /** Absent on legacy tokens; default "internal". */
  type?: "internal" | "external";
  /** Servable avatar path, or null when the user never set one. */
  avatar_url?: string | null;
}

export interface NoxLoginRequest {
  email: string;
  password: string;
}

export interface NoxLoginResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: string;
  user: NoxAuthUser;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion AUTH TYPES
// (o==================================================================o)
