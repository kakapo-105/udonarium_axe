/**
 * The fork's tools that read this machine's files, as the bridge offers them to the AI: their input
 * is JSON Schema as tools/mcp-server gave it (it holds anyOf and patterns, which the app's own
 * schema does not), without the sessionId and requestId the link fills in itself. Written once from
 * that tool list; kept by hand from here on.
 */
export interface ForkBridgeToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export const FORK_BRIDGE_TOOLS: readonly ForkBridgeToolDefinition[] = [
  {
    name: 'chat_send',
    title: 'Say lines',
    description:
      'Send public chat in an allowed tab as yourself or a controllable character. BCDice expressions are supported, and the answers of the dice bot to a line with dice come back in `rolls` (text, and `outcome` critical / fumble / success / failure when the bot told), so no read_chat is needed to read the result. A line with no piece speaking is rolled under the default dice bot of the room. The answer to a secret roll (an S in front, such as S2d6 or SCCB<=50) comes back too, marked secret: true; only the roller sees it, so do not repeat it in public. A line of resource commands on the speaking character (:HP-5, :HP-2d6, :HP-if([2d6]>=10,5,0), $1 reads the first bracketed roll again; up to 10 on one line separated by spaces, such as :HP+6 :MP+3, and nothing else on that line) also needs edit_resource; write each without spaces. In lines, such a line with its characterId changes that piece, so a rest that restores several pieces is one call: the narration, then one resource line per piece. References ({name}), targets (t:, t&), an @word at the end of a line (it picks a portrait) and 《name》 naming one of the effects of the room (it plays it) are refused, and the error says how to write it instead; any other 《》, such as the name of a feat, and an @ inside a sentence are said as they are. style stages the line as the kinds in the chat input do, standing out in the log and in novel mode: narration (description by the narrator), location (a place heading, when the party arrives somewhere) or scene (a scene heading, when the scene changes). Give text for one line, or lines for several said in order in one call (a heading, the narration, then each NPC line as that NPC piece): each waits for the one before to be typed out and read in novel mode, so none is hidden, and the call returns once all are said (sent lists each identifier; on a failure the rest are not said and failed says which and why). Prefer lines to several calls. linesFile (a .json file in the scenario folder, by its path from there) and linesKey say lines written before the session, kept in that file under that key, instead of giving them here: they are said just as lines are, and come back in lines so you know what was said. dryRun checks them without saying them.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
        },
        characterId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        style: {
          type: 'string',
          enum: ['normal', 'narration', 'location', 'scene'],
        },
        lines: {
          minItems: 1,
          maxItems: 20,
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                minLength: 1,
                maxLength: 2000,
              },
              characterId: {
                type: 'string',
                minLength: 1,
                maxLength: 256,
              },
              style: {
                type: 'string',
                enum: ['normal', 'narration', 'location', 'scene'],
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        linesFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        linesKey: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
        dryRun: {
          type: 'boolean',
        },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'vn_stage',
    title: 'Stage a novel scene',
    description:
      'Stage a scene of talk in novel mode, all in one call: bgmFile (a file in the sound folders) plays the music of the scene, carrying on if that track is already playing, stopBgm: true stops the music, and fade: true darkens every screen for a moment while the rest changes, for a change of place or time. open: true opens novel mode on every screen (false closes it), backgroundFile sets the picture behind the speakers from the image folder (clear: true removes the picture, not the speakers), transition (fade, wipe, none) plays as it changes. Speakers stand in by themselves from the pieces whose lines are shown, so speak NPC lines with chat_send characterId set to the NPC piece; a piece put out of sight (piece_conceal) or removed leaves the stage. Opening or closing clears the speakers of the scene before from the stage (resetCast, default true whenever open is given; false keeps them), drawing the line in tabId (default the first tab, the main one). Use it for scenes centred on talking with NPCs, and close it when the talk ends; otherwise play on the table. Game master only.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        open: {
          type: 'boolean',
        },
        backgroundFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        clear: {
          type: 'boolean',
        },
        transition: {
          type: 'string',
          enum: ['fade', 'wipe', 'none'],
        },
        resetCast: {
          type: 'boolean',
        },
        tabId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        bgmFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        stopBgm: {
          type: 'boolean',
        },
        fade: {
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bgm_play',
    title: 'Play music',
    description:
      "Play music for the whole room, as the jukebox does: file names a sound file in the sound folders (see room_template_list), which is taken into the room first; identifier plays a sound the room already holds, such as a table's music. loop defaults to true. loop: false plays it once through, as a jingle, and then goes back to the music that was playing (the then field of the result names it), or to thenFile (a file in the sound folders) or then (a SHA-256 the room holds; empty for silence afterwards). stop: true stops the music. Choosing a table with switch_table plays that table's own music. Game master only.",
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        identifier: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
        loop: {
          type: 'boolean',
        },
        thenFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        then: {
          type: 'string',
          pattern: '^([0-9a-f]{64})?$',
        },
        stop: {
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'room_audio_restore',
    title: 'Restore the room’s sounds',
    description:
      'Take back into the room the music and cut-in sounds its tables and cut-ins name but it does not hold, as after a saved room is loaded, since a save keeps no sounds. They are found by content in the sound folders. missingAudio lists any still not found. Call it once after the room is loaded. Game master only.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'self_set',
    title: 'Set how the AI speaks as itself',
    description:
      'Set the name and picture automation speaks under when it speaks as itself (chat_send with no characterId), as the connection panel does: name (such as GM) and imageFile (a picture in the image folder, kind portrait) or image (a SHA-256 the room holds). Call it once when the session starts, so narration carries a face of its own.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
        imageFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        image: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'table_set',
    title: 'Change a table',
    description:
      "Dress a table as its settings do: surfaceFile / backgroundFile put a picture from the image folder on the table's surface or behind it (surface / background take a picture the room already holds by SHA-256, or empty to clear), filter (none, white, black) dims or lightens the picture behind so the table stands out, and bgmFile (a file in the sound folders) or bgm (a SHA-256 the room holds, stop for silence, empty to leave the music alone) is played whenever the table is chosen, at once if it is in view. Leave the surface of a generated dungeon or field alone: its floor is the map. For a battle board, the same picture on the surface and behind it with a filter reads well. Game master only.",
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        surfaceFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        backgroundFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        surface: {
          type: 'string',
          pattern: '^([0-9a-f]{64})?$',
        },
        background: {
          type: 'string',
          pattern: '^([0-9a-f]{64})?$',
        },
        filter: {
          type: 'string',
          enum: ['none', 'white', 'black'],
        },
        bgmFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        bgm: {
          type: 'string',
          pattern: '^([0-9a-f]{64}|stop)?$',
        },
      },
      required: ['identifier'],
      additionalProperties: false,
    },
  },
  {
    name: 'table_create',
    title: 'Build a table',
    description:
      "Build a new table. kind board builds a battlefield from a board template given by templateUrl on an allowed piece source (such as the rulebook server's /api/boards/basic, /advanced or /expert for Sword World 2.5's basic, advanced and expert combat): the table wears the template's picture, and the template's rule, guide, areas (rectangles in cells) and scale come back to say where pieces stand; name, width and height may override the template's. kind dungeon or field builds a table from a generated map, as the map generator panel does at its defaults, and returns the master's notes on it: the way in, each room's number, part and rectangle in cells (x, y, w, h from the top-left), and the traps. kind dungeon takes atmosphere stoneDungeon / crypt / ruins / cavern / lavaCavern / iceCave / sandTomb / illegalBar / abandonedBuilding / containerWarehouse, roomCount (3-20, default 8) and trapCount (0-30). kind field takes atmosphere woodland / meadow / coast / marsh / snowfield / wasteland / city / sfCity / slum / dump / oldTown, size (cells across, default 40; three deep for every four across) and density (0-100). The same seed rolls the same map; left out, a random one is used and returned. fog starts the table under the fog of war. flat sets whether the table recommends a flat 2D view or perspective (see table_view). kind board with backgroundFile (a picture in the image folder, see room_template_list) instead of templateUrl builds a one-picture scene, such as a tavern or a town gate: the picture lies on the table, flat, width x height cells (default 32 x 18, for a 16:9 picture), and grid shows the grid; set pieces on it with character_create. floorFile and wallFile dress a dungeon or field in a picture from the image folder (kind texture or wall). floor and wall dress a dungeon or field in a bundled texture (such as stone_tile, wood_plank, marble; walls such as those the atmosphere uses) instead of the atmosphere's own; wallHeight sets how tall walls stand in cells. The table is not put in view; use switch_table. Takes up to two minutes. Game master only.",
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['dungeon', 'field', 'board'],
        },
        atmosphere: {
          type: 'string',
          enum: [
            'stoneDungeon',
            'crypt',
            'ruins',
            'cavern',
            'lavaCavern',
            'iceCave',
            'sandTomb',
            'illegalBar',
            'abandonedBuilding',
            'containerWarehouse',
            'woodland',
            'meadow',
            'coast',
            'marsh',
            'snowfield',
            'wasteland',
            'city',
            'sfCity',
            'slum',
            'dump',
            'oldTown',
          ],
        },
        templateUrl: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
        },
        width: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
        },
        height: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
        },
        seed: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        roomCount: {
          type: 'integer',
          minimum: 3,
          maximum: 20,
        },
        trapCount: {
          type: 'integer',
          minimum: 0,
          maximum: 30,
        },
        size: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
        },
        density: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
        },
        fog: {
          type: 'boolean',
        },
        flat: {
          type: 'boolean',
        },
        floor: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
        wall: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
        wallHeight: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 10,
        },
        floorFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        wallFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        backgroundFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        grid: {
          type: 'boolean',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'character_create',
    title: 'Put new characters',
    description:
      'Put 1 to 20 new pieces on the table in a row from x, y (the top-left cell, grid by default), owned by you, from sheets: this tool\'s own <character> XML (as its save data holds) or the ccfolia clipboard form ({"kind":"character","data":{...}}). Give them inline as pieces, or as sourceUrl on an allowed piece source (such as the rulebook server\'s /api/udonarium?name=...&count=3), which is fetched here, with the pictures it names, so neither ever passes through the conversation; a picture that cannot be fetched is reported in sourceWarnings and the piece is built without it. disclosure gm leaves the piece and its name on the table but keeps its sheet and numbers to the game master; it is the default for a game master. concealed: true (game master only) makes them out of sight instead, drawn on no table and listed to no player, until piece_reveal brings them out where they were put; this is how monsters are set out before a session. Pieces are shared by every table, so a piece left on the table shows on whichever table is in view. dicebot sets the palette\'s dice bot, a BCDice game system id (SwordWorld2.5 for Sword World 2.5, whose power-table lines need it; Cthulhu for Call of Cthulhu 6th edition, whose CCB lines need it; Cthulhu7th for the 7th edition, whose CC lines need it); a ccfolia sheet names none. imageFile dresses every piece in a picture from the image folder instead of its own, such as an NPC portrait made for the scene (novel mode shows the speaking piece\'s picture). imageHeight gives the pieces\' picture a height of its own in pixels, so a portrait taller than it is wide (2:3) stands on its base at its own shape instead of being squeezed into a square. Nothing is built if any sheet cannot be read or the row will not fit.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        pieces: {
          minItems: 1,
          maxItems: 20,
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'string',
                minLength: 1,
                maxLength: 200000,
              },
              {
                type: 'object',
                propertyNames: {
                  type: 'string',
                },
                additionalProperties: {},
              },
            ],
          },
        },
        sourceUrl: {
          type: 'string',
          minLength: 1,
          maxLength: 2048,
        },
        x: {
          type: 'number',
          minimum: 0,
        },
        y: {
          type: 'number',
          minimum: 0,
        },
        unit: {
          type: 'string',
          enum: ['grid', 'px'],
        },
        disclosure: {
          type: 'string',
          enum: ['all', 'gm'],
        },
        concealed: {
          type: 'boolean',
        },
        dicebot: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
        imageFile: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        imageHeight: {
          type: 'integer',
          minimum: 0,
          maximum: 2000,
        },
        dryRun: {
          type: 'boolean',
        },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'room_template_list',
    title: 'List room templates and files',
    description:
      'List the room templates kept on this machine (rooms saved from Udonarium Axe and unzipped into the templates folder), each with the names of its tables and the description in its template.json, the sound files in the sound folders with the identifiers rooms know them by and what the index.json of the sound folder says of each (use such as battle, town, dungeon, tension, ending; tags; note), and the pictures in the image folder with what its index.json says of each (kind: background, portrait, texture or wall; tags; note). Nothing in the room is read.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'room_template_load',
    title: 'Load a room template',
    description:
      "Build tables from a room template alongside the tables in play, for a scene's backdrop and music or a battlefield with its ranges and cut-ins. tables names the tables to build (all when left out); the template's ranges, cut-ins, notes and pieces come too, except what the room already has under the same identifier. A template's pictures come from its folder, and the sounds its tables and cut-ins name are found by content in its folder or the sound folders, since a saved room keeps no sounds; missingAudio and sourceWarnings say what could not be found. config (default true) takes the template's rules of play, such as the dice bot and turn order, keeping the room's volume and automation settings. presets also adds the template's effect library. templateNotes returns the template's template.json as written by the master, such as how each table is laid out (scale, where each side starts) and when to use it; read it before placing pieces. Pieces and notes come without an owner, unless adopt is true: then whatever had an owner in the save becomes yours, so you can reveal, conceal and lock it, as when the template is a whole room you set out again (a test room). A saved room keeps no identifiers, so everything gets new ones each time it is loaded: the result names the tables, pieces (name, place) and notes (title, place) it built with their identifiers. A template is a folder, or the zip a room is saved as, placed in the templates folder under the template's name. Nothing is put in view; use switch_table. Game master only.",
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        tables: {
          minItems: 1,
          maxItems: 20,
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
          },
        },
        config: {
          type: 'boolean',
        },
        presets: {
          type: 'boolean',
        },
        adopt: {
          type: 'boolean',
        },
      },
      required: ['template'],
      additionalProperties: false,
    },
  },
];
