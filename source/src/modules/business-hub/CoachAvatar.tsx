// A coach's photo, or their initials where there is none. Its own file so the
// coaches list in Settings can draw it without pulling in the whole profile
// panel, which is loaded on demand with the Profile view.

function initialsOf(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

export function CoachAvatar({ name, photoUrl, size = 96 }: { name: string; photoUrl?: string; size?: number }) {
  return (
    <span className="cp-avatar" style={{ width: size, height: size, fontSize: Math.round(size / 3) }} aria-hidden="true">
      {photoUrl ? <img src={photoUrl} alt="" /> : initialsOf(name)}
    </span>
  );
}
