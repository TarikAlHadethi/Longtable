import { RoomPage } from "./room-page";

export default async function TablePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const q = await searchParams;
  return <RoomPage id={(await params).id} wanted={q.c} side={q.side === "client"} sandbox={q.sandbox} />;
}
