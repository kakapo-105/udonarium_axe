/**
 * The event novel mode is opened and closed by on one screen, announced on that device alone with
 * `{ active }`. Whatever draws differently while the screen is in novel mode listens for it.
 */
export const VN_MODE_EVENT = 'VN_MODE';

/**
 * The network event by which the game master opens or closes novel mode on every screen. VN_MODE
 * is this device's own and no peer may send it, so word for the room goes under this name, and
 * a screen takes it from a game master alone.
 */
export const VN_ROOM_MODE_EVENT = 'VN_ROOM_MODE';
