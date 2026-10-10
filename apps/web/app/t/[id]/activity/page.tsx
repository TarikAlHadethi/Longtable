import { RoomPage } from "../room-page";

// The logs are the room, opened on its logs.
export default async function Activity({ params }: { params: Promise<{ id: string }> }) {
  return <RoomPage id={(await params).id} view="logs" />;
}
