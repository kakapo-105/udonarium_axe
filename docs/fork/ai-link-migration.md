# フォークのAI操作を上流のAI連携へ寄せる

2026-11-20に決めた。v1.81.0で上流のAI GMがMCP経由のAIアプリ（Claude Code）で動くようになったので、
フォーク独自のMCP（`tools/mcp-server`）を上流のAI連携（`tools/axe-mcp` + ブラウザ側の道具）に寄せる。
2026-11-18の「上流のAI連携には手を入れない」は改める。

## 2つのしくみ

|                | フォーク（`tools/mcp-server`）                                     | 上流（`tools/axe-mcp`）                                                                                              |
| -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| ブラウザ       | PlaywrightでAI専用のブラウザを開く（`automation=1`）               | GMの席のタブがブリッジにWebSocketでつながる                                                                          |
| 道具の定義     | Node側（zod）。55個                                                | `core/agent/agent-tools.ts`（`AGENT_TOOLS`）。ブリッジとタブの両方に同じ一覧を組み込み、つなぐときにdigestで照合する |
| 道具の実行     | Node → `invokeFacade` → `application/automation`のfacade           | ブリッジ → タブ → `features/agent-tools`のハンドラ（`AgentToolRunner.provide`）                                      |
| 待ち方         | `chat_wait`（タブ指定、`settleSeconds`、駒が止まったら返す）       | `wait_for_turn`。タブが出来事を集め、静かになって4秒（最長15秒）で番を渡す                                           |
| 番が来る理由   | 発言・駒の停止・時間切れ                                           | PLの発言、呼び名か秘話、AIが動かすコマの手番、GMの席の人の「進めて」                                                 |
| 手元のファイル | Node側で読む（テンプレート・音・画像・台詞、ルールブックサーバー） | なし                                                                                                                 |

ブリッジは道具の一覧を組み込みで持つので、上流が配る`axe-mcp.mjs`はフォークのアプリにはつながらない（digestが合わない）。
フォークは自分で`npm run build:mcp`したブリッジを使う。

## 道具の対応表（55個）

使用数はsw25-ai-gmのスキル・テストに出てくる回数（多いほど切り替えの影響が大きい）。

### A. 上流の道具に置き換える（10）

| フォーク           | 上流                       | 違い・確かめること                                                                                                                            |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_wait`        | `wait_for_turn`            | 駒が止まっても番は来ない（`piece_moved`は出来事として届くだけ）。時間切れで起きる仕組みもない。地図の探索（例外の側）で駒を待つ所をどうするか |
| `chat_read_recent` | `read_chat`                | 聞くタブに絞られる                                                                                                                            |
| `session_get`      | `get_room`                 | `sessionId`・許可されたscope・タブのidの代わりを確かめる                                                                                      |
| `scene_list`       | `list_pieces`              | 隠したコマ（`place concealed`）の扱い                                                                                                         |
| `object_get`       | `get_piece`                |                                                                                                                                               |
| `piece_move`       | `move_piece`               | 厳密な移動・踏むと動く仕掛け（トリガー）が同じに働くか                                                                                        |
| `piece_remove`     | `remove_piece`             | 墓場に送るか、消すか                                                                                                                          |
| `turn_get`         | `get_turn_order`           |                                                                                                                                               |
| `table_select`     | `switch_table`             |                                                                                                                                               |
| `buff_send`        | `add_buff` / `remove_buff` | `&R-`などのまとめ操作は`buff_sweep`側へ                                                                                                       |

### B. ブラウザ側の道具として移す（34）

facadeを呼ぶだけで、Node側の処理がないもの。`application/automation`のサービスはそのまま使い、
`features/agent-tools`の流儀でハンドラを足し、定義を`AGENT_TOOLS`に連ねる。

`view_get` `switch_press` `door_press` `character_sheet_get` `palette_get` `palette_send` `buff_list` `buff_edit`
`buff_sweep` `turn_set` `character_update` `piece_disclose` `piece_rename` `piece_lock` `piece_reveal` `piece_conceal`
`piece_stealth` `chat_check` `game_clock_set` `table_list` `fog_reveal` `terrain_list` `door_set` `light_place`
`switch_list` `switch_set` `ambience_list` `ambience_set` `range_list` `range_set` `view_focus` `table_view`
`chat_tab_create` `note_create`

`turn_set` / `character_update` / `range_set`は上流の`advance_turn` / `change_resource`・`set_sheet_value` / `place_range`・`remove_range`
と一部重なるが、フォークのほうができることが多いので残す。

### C. ブリッジ（Node）側の前処理が要る（10）

手元のフォルダかルールブックサーバーから読み、中身をつけてタブの道具を呼ぶ。
今の`tools/mcp-server`の前処理（`template-source` / `piece-source` / `prepared-lines` / `zip-reader`）を`tools/axe-mcp`へ移す。

| 道具                                        | 読むもの                                                             |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `chat_send`（`lines` / `linesFile`）        | シナリオの台詞ファイル（`UDONARIUM_SCENARIO_DIR`）、読む時間の間合い |
| `vn_stage`                                  | 画像・音（`UDONARIUM_IMAGE_DIR` / `UDONARIUM_AUDIO_DIR`）            |
| `bgm_play` / `room_audio_restore`           | 音                                                                   |
| `self_set` / `table_set`                    | 画像・音                                                             |
| `table_create`                              | 盤のテンプレート（ルールブックサーバー）、背景画像                   |
| `character_create`                          | キャラクターシート（ルールブックサーバー`UDONARIUM_PIECE_SOURCES`）  |
| `room_template_list` / `room_template_load` | 部屋のテンプレートzip（`UDONARIUM_TEMPLATE_DIR`）                    |

### D. このままでは移せない（1）

| 道具         | 理由と案                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `screenshot` | PlaywrightでAI専用のブラウザを撮っている。GMの席のタブは撮れない。案: 自動テスト（run.mjs）は自分で開いたブラウザを撮る。遊ぶときは使わない |

## 変わること

- AI専用のブラウザがなくなる。遊ぶあいだ、誰かのPCでGMの席のタブを開いておく（多人数ではホストのPC）
- 番の渡し方・聞くタブ・出番・指示・メモは「AI連携」パネルの「GMを任せる」で決める。sw25-ai-gmのスキルはこれを前提に書き直す
- 上流の`run_ai_gm`のGMの心得（`GM_GUIDE`）は使わず、sw25-ai-gmのスキルから`wait_for_turn`を直接呼ぶ
- `automation=1`でfacadeを読み込む作りを、ブリッジにつながったタブで読み込む作りに変える
- 権限: フォークのscope（`automation-policy`）と、上流の`read` / `write` / `gm`と「AIに書くことを許す」を一つにする

## 上流のファイルに手を入れる所（取り込みで競合しうる所）

- `core/agent/agent-tools.ts`の`AGENT_TOOLS`に、フォークの定義を連ねる1行
- `features/agent-tools/agent-tools-setup.service.ts`の`provide`に1行
- `tools/axe-mcp/src/mcp-server.ts`の道具の呼び出しに、Cの前処理を挟む口
- （必要なら）`core/agent/agent-gm.ts`の番が来る理由に、駒の停止を足す

## 進め方

1. Bの道具を移す（定義の書き換えと、facadeを呼ぶハンドラ）。古いMCPも並べて動かしたままにする
2. Cの前処理をブリッジへ移す
3. Aの置き換えと、駒の停止で番を起こすかを決める
4. sw25-ai-gmのスキルと`/sw25-test`（run.mjs）を切り替え、全部が上流のしくみで通ったら`tools/mcp-server`を外す
