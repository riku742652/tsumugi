include "root" {
  path = find_in_parent_folders("terragrunt.hcl")
}

terraform {
  source = "../../../modules/ecr"
}

inputs = {
  app_name  = "zaim-csv"
  repo_name = "zaim-csv-api"
}
