import type { Presence, PublicUser } from "@nexus/protocol";
import { hueFor, initials } from "@nexus/shared";
import { presenceColor } from "@nexus/ui";
import { memo } from "react";
import { client } from "../lib/nexus";

interface Props {
  user: Pick<PublicUser, "id" | "display_name" | "avatar_url"> | undefined;
  size?: number;
  presence?: Presence;
  speaking?: boolean;
}

export const Avatar = memo(function Avatar({ user, size = 36, presence, speaking }: Props) {
  const url = user?.avatar_url ? client().api.url(user.avatar_url) : undefined;
  const name = user?.display_name ?? "?";
  const hue = hueFor(user?.id ?? "?");
  return (
    <span
      className={`avatar${speaking ? " speaking" : ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {url ? (
        <img src={url} alt="" loading="lazy" decoding="async" width={size} height={size} />
      ) : (
        <span className="avatar-fallback" style={{ background: `hsl(${hue} 45% 32%)` }}>
          {initials(name)}
        </span>
      )}
      {presence && (
        <span
          className="presence-dot"
          style={{ background: presenceColor(presence), width: size * 0.3, height: size * 0.3 }}
          title={presence}
        />
      )}
    </span>
  );
});
