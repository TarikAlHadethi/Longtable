import { RoomPage } from "../room-page";

// Settings is the room, opened on its settings.
export default async function Settings({ params }: { params: Promise<{ id: string }> }) {
  return <RoomPage id={(await params).id} view="settings" />;
}
