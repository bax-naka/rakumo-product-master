# rakumo製品マスター申請連携

rakumoワークフローの製品マスター「新規登録」「変更申請」の承認結果を、F-2Rが公開しているGoogle Sheetsから読み取り、管理用ブック（管理マスター）を更新するための独立GAS。

## 段階

### Step B（読取・判定）

- 書き込み処理は含まない。`appsscript.json` の権限は `spreadsheets.readonly` のみ。
- 読取は Sheets API 拡張サービス（`Sheets.Spreadsheets.Values.batchGet`）で行う。`SpreadsheetApp.openById` は書込みを含む権限を要求するため使わない。
- F-2R公開Sheetsを `control` の有効スロットから読み、世代・件数・読取前後の `control` 一致を確認する。
- 対象Form × status 2/5 × 処理台帳未登録 × 開始基準以降（テスト台帳記載分は例外）を候補とし、決裁日時順に判定する。
- 判定は仮想の管理マスターに順次適用する（同一製品への連続変更・型番重複を検出するため）。実際の管理マスターは変更しない。

### Step C（管理マスターへの書込み）

- `pmApplyUpdates` は Script Property `WRITE_ENABLED` が `true` のときだけ書き込む（それ以外はプレビューのみ）。権限は `spreadsheets`。
- 書込み先は管理用ブックだけ。F-2R公開Sheetsは Sheets API で読むだけで、書込み用に開かない（IDが同じなら停止）。
- スクリプトロック内で実行。処理台帳（`処理台帳` タブ、初回に自動作成）へ先に「処理中」を記録してから管理マスターを書き、読み戻して一致したら「マスター反映済み」にする。保留は理由とともに「保留」で記録し、以後は自動で再判定しない（再判定は台帳行を削除）。
- 途中で止まった「処理中」は次回、管理マスターを反映前・反映後と照合して復旧する。どちらとも一致しなければ「エラー」にして停止し、人が確認するまで処理しない。
- 新規は行を追加し、`製品ステータス表示` 列は上の行の数式を引き継ぐ。値は書式なしテキストで書く（`021` などの先頭0を保持）。変更は差分のセルだけ書き、直前に判定時の値と一致することを確認する。
- 管理コードは管理マスターと処理台帳の最大値+1。番号は再利用しない。
- 反映がある回だけ、管理マスターを非表示タブ `bk_管理マスター_日時` に複製する（最新5つを保持）。

### Step D（準備：rakumo LookupData の読取）

- API仕様: https://sites.google.com/gigei.jp/rakumoapi （ワークフローAPI実装ガイド・認証方式）
- `pmCheckLookupData` は LookupData LIST/GET だけを呼び、テスト用ルックアップ2件のID・行数・列・`isBuilding`・`lastRefreshed` を表示する（REFRESHは呼ばない）。
- 認証は RWS（HMAC-SHA1、Date±15分）。429/50x は指数バックオフで最大3回、40x は再試行しない。
- APIキーはF-2Rと同じアカウント（Workflow管理者以上）のものを使い、GASの**ユーザープロパティ**に保存する。設定はスクリプトプロパティに一時的に `RAKUMO_API_KEY`・`RAKUMO_API_SECRET` を入れて `pmMoveRakumoKeyToUserProperties` を実行（移したあと元は削除される）。
- **キーを再発行したときは、F-2R（Windows）とこのGASの2か所を更新する。**
- 追加のスクリプトプロパティ：`LOOKUP_ACTIVE_SPREADSHEET_ID`（製品マスター(仮)）、`LOOKUP_INACTIVE_SPREADSHEET_ID`（製品マスター(削除)）。

### Step D（公開ファイル再生成と rakumo 再取込）

- `pmApplyUpdates` は書込みのあと続けて、`pmPublishLookups` は単独で、管理マスターから公開用2ファイル（製品マスター(仮)＝有効、製品マスター(削除)＝無効）を全件作り直す。内容が同じなら書かない。先頭シートだけを書き換え、ファイルIDは変えない。値は名称付き表示・rakumo取込規則で正規化・書式なしテキスト。型番空欄・100文字超・未定義コードがあれば書かずに停止。
- `LOOKUP_REFRESH_ENABLED=true` のときだけ LookupData REFRESH を呼ぶ。完了判定は rakumo 側の値だけで行う（REFRESH前より `lastRefreshed` が新しい・`isBuilding` なし・`rowCount` と列名が一致）。400（更新中）は次回に再要求。30分以上終わらなければエラー。
- 状態は管理用ブックの `公開状態` タブ（role ごと：最新／取込待ち／取込中／エラー）。両方が最新になった回に、処理台帳の「マスター反映済み」行を「完了」（lookup_status=反映済み）にする。エラーは自動では戻さない（内容を確認後、status を `取込待ち` に直すと再要求する）。

### Step D（定期実行と通知）

- 本番入口は `pmScheduledRun`（`WRITE_ENABLED=true` のときだけ処理）。`pmInstallTrigger` で15分ごとの時間主導トリガーを1本だけ設置、`pmRemoveTriggers` で解除。
- 通知はマスター管理者（Script Property `NOTIFY_EMAIL`）だけ。成功時は送らない。新たに保留にした申請、新たにエラーになった公開先、例外停止（同じ内容は24時間に1回まで、正常に戻ると解除）。`pmSendTestMail` で送信テスト。
- F-2R 停止の検知：毎回 F-2R の control を読み、平日 9:30〜17:30 に「最終同期が今日で、30分より古い」＝今日動いた後に止まったときだけ「F-2R 同期停止」を1通（同じ停止は再通知しない）、再開したら「F-2R 同期再開」を1通送る（状態は Script Property `PM_F2R_STALE`）。F-2R は作業用PCで動くため、PCを起動していない日（祝日・出張・休暇）は通知しない。
- F-2Rの公開切替と読取が重なって control が変わった場合は、10秒待って最大3回まで読み直す。

## 削除・復帰申請（form_key = delete_restore）

- 区分（ラジオ「削除／復帰」）で使うルックアップを決める：削除＝製品マスター(仮)、復帰＝製品マスター(削除)。
- 申請時のスナップショットと現在の管理マスターを照合し、変えるのは `管理状態` と `無効理由` だけ。
  削除：有効→無効、無効理由＝申請の理由（前後空白除去・改行は保持）／復帰：無効→有効、無効理由を空に（以前の理由は処理台帳と変更履歴に残る）。
- 保留：区分が空・不正、区分側のルックアップ未選択、反対側にも選択、列不足、管理コード欄とルックアップの不一致、管理コード不在、
  状態不一致（削除なのに無効・復帰なのに有効＝二重申請など）、スナップショット不一致、理由が空、復帰で型番重複。
- 管理用ブックの設定：「対象Form」に `delete_restore` 行、「項目マッピング」に次の5行（item_id は F-2R 登録後の公開データで確定）。

| internal_key | item_role | 項目 |
|---|---|---|
| kind | value | 削除・復帰（ラジオ） |
| target_delete | lookup | 削除型番（製品マスター(仮)） |
| target_restore | lookup | 復帰型番（製品マスター(削除)） |
| management_id | lookup_copy（区分別なら lookup_copy_delete / lookup_copy_restore） | 管理コード（転記欄、あれば照合） |
| reason | value | 理由 |

## 構成

| パス | 内容 |
|---|---|
| `gas/` | 連携GASのソース（gas-devops Skill の `sourceDir`） |
| `viewer/` | 製品マスター Webビューワ（読取専用の別GASプロジェクト）のソース |
| `test/` | Node.jsでGASを再現実行する試験（SpreadsheetApp等のモック） |
| `tools/to_json.py` | 書き出したxlsxを試験用JSONへ変換 |
| `gas-devops.config.example.json` | gas-devops Skill用設定の雛形（実IDは入れない） |

## Script Properties（GAS側で設定。Gitには入れない）

| キー | 内容 |
|---|---|
| `F2R_SPREADSHEET_ID` | F-2R公開Sheets |
| `MASTER_SPREADSHEET_ID` | 管理用ブック |
| `PROCESS_START_AT` | 開始基準（ISO 8601、例 `2026-11-24T00:00:00+09:00`） |

管理用ブックに必要なタブ：`管理マスター`、`ステータス対応`、`区分対応`、`対象Form`、`項目マッピング`、任意で `テスト台帳`・`処理台帳`。16桁のIDは `text:` を付けて文字列で保持する。

## 実行（GASエディタ）

1. `pmCheckSetup` … 設定・読取権限・整合確認
2. `pmPreviewUpdates` … 判定と更新プレビュー（書き込みなし）
3. `pmVerifyAgainstTestLedger` … テスト台帳の期待結果と突合せ（反映後は処理台帳と管理マスターで確認）
4. `pmApplyUpdates` … 書込み（`WRITE_ENABLED=true` のときだけ）

## 反映（gas-devops Skill、Windows）

`gas-devops.config.example.json` を `gas-devops.config.json` にコピーして `scriptId` を設定（Git対象外）。

```text
node "<Skill>/scripts/run.mjs" fetch  --config "<絶対パス>/gas-devops.config.json" --project product-master-stepb
node "<Skill>/scripts/run.mjs" diff   --config "<絶対パス>/gas-devops.config.json" --project product-master-stepb
node "<Skill>/scripts/run.mjs" push --dry-run --allow-manifest --config "<絶対パス>/gas-devops.config.json" --project product-master-stepb
```

計画の内容を確認・承認してから、同じコマンドに `--execute --plan "<planFile>" --approve <HASH> --exclusive` を付けて実行する。

## 製品マスター Webビューワ（viewer/）

管理マスターを読み取り、「有効」（最初に表示）・「削除」・「全件（管理マスター）」をタブで切り替えて表示する閲覧専用のWebアプリ。値は公開ファイル（rakumoのルックアップ）と同じ変換をかける（試験で一致を確認）。

- 連携GASとは**別のGASプロジェクト**にする。Webアプリは「デプロイしたユーザーとして実行」で、`google.script.run` からは末尾が `_` でない関数を誰でも呼べるため、書込み系の関数を持つ連携GASに画面を足さない。
- scope は `spreadsheets.readonly` と `userinfo.email` だけ。公開関数は `doGet`・`vmLoad`・`vmCheckSetup` だけ（試験で固定）。
- 閲覧者は管理用ブックへの権限を持たなくてよい（デプロイしたユーザーの権限で読む）。
- 検索（型番・商品CD・管理コード・U番号、全角/半角を区別しない、空白区切りでAND）、製品ステータス・大分類・提供先での絞り込み、列見出しでの並べ替え。
- 最終反映は処理台帳で「完了」になった最新の更新時刻。
- 変更履歴：先頭の「履歴」列から、処理台帳で反映済み（完了・マスター反映済み）の申請を新しい順に表示する（申請番号・決裁日時・区分・変わった項目の前後）。保留は出さない。自動反映の開始以降だけが対象。
- 閲覧できるのは `ALLOWED_DOMAIN` のアカウントと `ALLOWED_EMAILS` に個別に書いたアドレスだけ。Webアプリのアクセス設定「組織内」は同じGWS組織の別会社も含むため、コード側で絞る（取得できないアカウントは拒否）。

Script Properties（ビューワ側）

| キー | 内容 |
|---|---|
| `MASTER_SPREADSHEET_ID` | 管理用ブック |
| `ALLOWED_DOMAIN` | 閲覧を許すメールのドメイン（Webアプリのアクセス設定に加えて確認する） |
| `ALLOWED_EMAILS` | ドメイン以外で閲覧を許すアドレス（任意。カンマ・空白・改行区切り。GWS組織内のアカウントに限る） |
| `SHOW_INACTIVE_REASON` | `false` で無効理由を表示しない（既定は表示） |

初回はエディタで `vmCheckSetup` を実行して権限を承認し、件数がログに出ることを確認してからWebアプリとして公開する。

## 試験

実データ（申請内容・氏名・メールアドレス・ID）を含むため、試験データ `fixtures/` はGitに登録しない。F-2R公開Sheetsと管理用ブックをxlsxで書き出し、次で生成する。

```text
python3 tools/to_json.py fixtures/f2r.json <F-2R公開Sheets.xlsx>
python3 tools/to_json.py fixtures/master.json <管理用ブック.xlsx>
npm test          # 異常系・境界条件、書込み・復旧、公開、通知、ビューワ、削除・復帰の試験
npm run verify    # テスト台帳の期待結果との突合せ
```
