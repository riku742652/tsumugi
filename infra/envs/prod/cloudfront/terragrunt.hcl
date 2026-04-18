include "root" {
  path = find_in_parent_folders("terragrunt.hcl")
}

terraform {
  source = "../../../modules/cloudfront"
}

dependency "lambda" {
  config_path = "../lambda"
  mock_outputs_merge_strategy_with_state = "shallow"
  mock_outputs = {
    function_url  = "https://mock.lambda-url.ap-northeast-1.on.aws/"
    function_name = "zaim-csv-api"
  }
}

inputs = {
  app_name             = "zaim-csv"
  lambda_function_url  = dependency.lambda.outputs.function_url
  lambda_function_name = dependency.lambda.outputs.function_name
}
