include "root" {
  path = find_in_parent_folders("terragrunt.hcl")
}

terraform {
  source = "../../../modules/lambda"
}

dependency "cognito" {
  config_path = "../cognito"
  mock_outputs = {
    issuer    = "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_mock"
    client_id = "mockclientid"
  }
}

dependency "dynamodb" {
  config_path = "../dynamodb"
  mock_outputs = {
    table_arn  = "arn:aws:dynamodb:ap-northeast-1:123456789012:table/zaim-transactions"
    table_name = "zaim-transactions"
  }
}

inputs = {
  app_name            = "zaim-csv"
  image_uri           = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/zaim-csv-api:latest"
  dynamodb_table_arn  = dependency.dynamodb.outputs.table_arn
  dynamodb_table_name = dependency.dynamodb.outputs.table_name
  cognito_issuer      = dependency.cognito.outputs.issuer
  cognito_client_id   = dependency.cognito.outputs.client_id
}
