# rakumo製品マスター申請連携

rakumoワークフローの製品マスター「新規登録」「変更申請」の承認結果を、F-2Rが公開しているGoogle Sheetsから読み取り、管理用ブック（管理マスター）を更新するための独立GAS。

## 現在の段階：Step B（読取・判定のみ）

- 書き込み処理は含まない。`appsscript.json` の権限は `spreadsheets.readonly` のみ。
- F-2R公開Sheetsを `control` の有効スロットから読み、世代・件数・読取前後の `control` 一致を確認する。
- 対象Form × status 2/5 × 処理台帳未登録 × 開始基準以降（テスト台帳記載分は例外）を候補とし、決裁日時順に判定する。
- 判定は仮想の管理マスターに順次適用する（同一製品への連続変更・型番重複を検出するため）。実際の管理マスターは変更しない。

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
3. `pmVerifyAgainstTestLedger` … テスト台帳の期待結果と突合せ

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
npm test          # 異常系・境界条件
npm run verify    # テスト台帳の期待結果との突合せ
```
