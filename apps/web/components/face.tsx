// What goes inside a person's round picture: their photo if they set one, else the first letter of their name.
// The circle itself (its size, its colour behind the letter) belongs to whatever draws it.
export type Faced = { display_name: string; color?: string; avatar?: string | null };

export const initialOf = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

export function Face({ who, name }: { who?: Faced | null; name?: string }) {
  if (who?.avatar) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="face-img" src={who.avatar} alt="" draggable={false} />;
  }
  return <>{initialOf(who?.display_name ?? name ?? "")}</>;
}
