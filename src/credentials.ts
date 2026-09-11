// The one payload this Worker ever accepts: a bifrost group package and
// the one share package that belongs to it. This is the `frost-share`
// profile of the QR secret transfer specification as this project reads
// NKM 3.3 -- frost-share = bfshare + bfgroup -- and it is also the shape
// of OWNER_CREDS. Both arrive as text; both are refused unless the share
// is a member of the group (QRST P4).
import { decodeGroupPackage, decodeSharePackage, isGroupMember, type GroupPackage, type SharePackage } from "./frost.ts";

export interface Credentials {
  group: GroupPackage;
  share: SharePackage;
  // The bech32m strings, kept for storage and for re-encoding nothing:
  // what was accepted is what is stored.
  groupStr: string;
  shareStr: string;
}

export type CredentialParse = { ok: true; creds: Credentials } | { ok: false; reason: string };

// Two strings, either order, separated by whitespace or a comma; or a
// JSON object with `group` and `share`. Anything else is refused with a
// reason that names what would have worked.
export function parseCredentialPair(text: string): CredentialParse {
  let groupStr: string | undefined;
  let shareStr: string | undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.group === "string") groupStr = obj.group.trim();
      if (typeof obj.share === "string") shareStr = obj.share.trim();
    } catch {
      return { ok: false, reason: "expected a bfgroup1... and a bfshare1... string, or JSON with group and share" };
    }
  } else {
    for (const part of trimmed.split(/[\s,]+/)) {
      const lower = part.toLowerCase();
      if (lower.startsWith("bfgroup1")) groupStr = lower;
      else if (lower.startsWith("bfshare1")) shareStr = lower;
    }
  }
  if (groupStr === undefined || shareStr === undefined) {
    return { ok: false, reason: "expected a bfgroup1... and a bfshare1... string" };
  }
  return credentialsFromParts(groupStr, shareStr);
}

export function credentialsFromParts(groupStr: string, shareStr: string): CredentialParse {
  const group = decodeGroupPackage(groupStr);
  if (group === null) return { ok: false, reason: "the group string does not decode as a bfgroup1... package" };
  const share = decodeSharePackage(shareStr);
  if (share === null) return { ok: false, reason: "the share string does not decode as a bfshare1... package" };
  // QRST P4, as NKM 3.3 defines it for frost-share: the share's public
  // point must be the group member at its index.
  if (!isGroupMember(group, share)) return { ok: false, reason: "the share does not belong to this group" };
  return { ok: true, creds: { group, share, groupStr: groupStr.trim(), shareStr: shareStr.trim() } };
}
