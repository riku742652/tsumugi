# Research: ECR Repository Management via Terraform/Terragrunt

## Relevant Files

**Infra modules (all under `infra/modules/`):**
- `infra/modules/lambda/main.tf` — Lambda function definition; constructs `local.ecr_repo_arn` by parsing `var.image_uri`; grants the Lambda role ECR pull permissions against that ARN. No ECR repository resource is created here.
- `infra/modules/cognito/main.tf` — Cognito User Pool + App Client; outputs `issuer` and `client_id`.
- `infra/modules/dynamodb/main.tf` — DynamoDB table; outputs `table_name` and `table_arn`.
- `infra/modules/cloudfront/main.tf` — CloudFront distribution + S3 frontend bucket; depends on Lambda outputs.

**Infra envs (all under `infra/envs/`):**
- `infra/envs/terragrunt.hcl` — Root config: S3 backend (`tsumugi-tfstate`), DynamoDB lock table (`tsumugi-tfstate-lock`), region `ap-northeast-1`, provider generation (AWS `~> 5.0`, random `~> 3.0`, Terraform `>= 1.6`).
- `infra/envs/prod/cognito/terragrunt.hcl` — No dependencies; passes `app_name = "zaim-csv"`.
- `infra/envs/prod/dynamodb/terragrunt.hcl` — No dependencies; passes `table_name = "zaim-transactions"`.
- `infra/envs/prod/lambda/terragrunt.hcl` — Depends on cognito + dynamodb; constructs `image_uri` via `run_cmd("aws sts get-caller-identity ...")` at plan time.
- `infra/envs/prod/cloudfront/terragrunt.hcl` — Depends on lambda; passes function_url and origin_secret_value.

**CI/CD:**
- `.github/workflows/terraform-apply.yml` — Single workflow; `workflow_dispatch` with `module` choice (cognito/dynamodb/lambda/cloudfront/all) and `env` choice (prod). Uses OIDC with `AWS_DEPLOY_ROLE_ARN` secret. TF 1.7.5, TG 0.55.18. The `run-all apply` step explicitly lists `--terragrunt-include-dir` for each of the four modules.

**Application:**
- `backend/Dockerfile` — Base image `public.ecr.aws/lambda/python:3.12`; embeds Lambda Web Adapter from `public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4`; copies `requirements.txt` and `app/`; CMD is uvicorn on port 8080.

**Project context:**
- `features.json` — Both `harness-setup` and `zaim-csv` are `done`. No ECR feature exists yet.
- `claude-progress.txt` — Next step noted as "Deploy infra with Terragrunt, build+push Docker image, deploy frontend to S3".

---

## Existing Patterns

**Module structure convention:** Each module is a single `main.tf` file containing variables, resources, outputs, and data sources all in one file. No separate `variables.tf`, `outputs.tf`, or `versions.tf`. The provider and backend are injected by Terragrunt's `generate` blocks in the root `terragrunt.hcl`.

**Terragrunt env convention:** Each env directory under `infra/envs/prod/<module>/` has exactly one `terragrunt.hcl`. It always starts with `include "root"`, then `terraform { source = "../../../modules/<name>" }`, optionally `locals`, optionally `dependency` blocks with `mock_outputs`, then `inputs = { ... }`.

**Naming convention:** App name is `"zaim-csv"`. Resources are named `"${var.app_name}-<suffix>"`. The ECR repo name in the current `image_uri` is `zaim-csv-api`. State key pattern is `${path_relative_to_include()}/terraform.tfstate`.

**image_uri construction:** Currently a Terragrunt local: `"${local.account_id}.dkr.ecr.ap-northeast-1.amazonaws.com/zaim-csv-api:latest"`. The account_id is obtained via `run_cmd("aws sts get-caller-identity ...")`.

**ECR ARN derivation in lambda module:** Lines 34–37 parse `var.image_uri` to extract the repo name and construct an ARN using data sources. This means the lambda module does NOT need the ECR module as a Terraform dependency — it derives the ARN from the URI string alone.

---

## Dependency Chain (current)

```
cognito ─┐
         ├──> lambda ──> cloudfront
dynamodb ┘
```

ECR has zero dependents and zero dependencies in the current graph. It would run in Group 1 (parallel with cognito/dynamodb) if added to `run-all`.

---

## Constraints & Gotchas

**The bootstrap problem (critical):** Three sequential prerequisites before Lambda can be applied:
1. ECR repository must be created
2. Docker image must be built and pushed to ECR
3. Lambda can then be applied (CreateFunction fails if `image_uri` does not point to an existing image)

**ECR is not a Terraform dependency of Lambda (currently):** The lambda module constructs the ECR ARN from the URI string. Adding a formal `dependency "ecr"` block would let `run-all apply` wait for ECR before Lambda, but the image must still pre-exist.

**`run-all apply` + `--terragrunt-include-dir`:** The existing workflow lists four explicit flags. A new `ecr` env dir must be added to this list.

**Docker build context:** The Dockerfile is at `backend/Dockerfile`. Build context root is `backend/`. Two public ECR images are used as base/copy sources.

**ECR image mutability:** `image_uri` uses `:latest` tag → `MUTABLE` required. Lambda caches the resolved image SHA at deploy time — updating Lambda to pick up a new image requires a new `terraform apply` on the lambda module or `aws lambda update-function-code`.

---

## Open Questions (resolved for plan)

1. **Formal `dependency "ecr"` in lambda?** → Yes. Lambda derives `image_uri` from `dependency.ecr.outputs.repository_url + ":latest"`, removing the `run_cmd` local. This makes the dependency explicit and eliminates hardcoded region/repo name.

2. **Bootstrap order?** → Document as: apply ECR first (standalone or via `module=ecr`), then push image via the new `ecr-push.yml` workflow, then `run-all apply` the rest.

3. **Workflow trigger for image push?** → `workflow_dispatch` AND push to `main` when `backend/**` changes.

4. **Image tag?** → `:latest` for now (MUTABLE). Lambda re-apply picks up new images.

5. **`image_tag_mutability`?** → `MUTABLE`.

6. **`scan_on_push`?** → `true`.

7. **ECR repository name?** → `zaim-csv-api` (consistent with current `image_uri`).
