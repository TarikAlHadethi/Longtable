import { RoomPage } from "./room-page";

export default async function TablePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  return <RoomPage id={(await params).id} wanted={(await searchParams).c} />;
}
