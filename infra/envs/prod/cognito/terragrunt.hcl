include "root" {
  path = find_in_parent_folders("terragrunt.hcl")
}

terraform {
  source = "../../../modules/cognito"
}

inputs = {
  app_name = "zaim-csv"
}
