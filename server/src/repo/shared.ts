/**
 * The fixed principal at the trusted-local repository boundary.
 *
 * This is local convenience, not an authentication identity. Keeping the
 * value here prevents repository domains from independently redefining the
 * boundary as they are extracted.
 */
export const LOCAL_OWNER_PRINCIPAL_ID = "local-owner";
