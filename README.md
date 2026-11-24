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

## 構成

| パス | 内容 |
|---|---|
| `gas/` | GASソース（gas-devops Skill の `sourceDir`） |
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

## 試験

実データ（申請内容・氏名・メールアドレス・ID）を含むため、試験データ `fixtures/` はGitに登録しない。F-2R公開Sheetsと管理用ブックをxlsxで書き出し、次で生成する。

```text
python3 tools/to_json.py fixtures/f2r.json <F-2R公開Sheets.xlsx>
python3 tools/to_json.py fixtures/master.json <管理用ブック.xlsx>
npm test          # 異常系・境界条件、書込み・復旧の試験
npm run verify    # テスト台帳の期待結果との突合せ
```
