variable "app_name" {
  type = string
}

variable "image_uri" {
  type        = string
  description = "ECR image URI for the Lambda function"
}

variable "dynamodb_table_arn" {
  type = string
}

variable "dynamodb_table_name" {
  type = string
}

variable "cognito_issuer" {
  type = string
}

variable "cognito_client_id" {
  type = string
}

variable "ecr_repository_arn" {
  type        = string
  description = "ARN of the ECR repository that holds the Lambda container image"
}

variable "cloudfront_domain" {
  type    = string
  default = ""
}

# Secrets Manager: X-Origin-Secret
resource "random_password" "origin_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "origin_secret" {
  name                    = "${var.app_name}/origin-secret"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "origin_secret" {
  secret_id     = aws_secretsmanager_secret.origin_secret.id
  secret_string = random_password.origin_secret.result
}

# IAM role for Lambda
resource "aws_iam_role" "lambda" {
  name = "${var.app_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ecr" {
  name = "ecr-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = var.ecr_repository_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "dynamodb" {
  name = "dynamodb-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:PutItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
      ]
      Resource = [
        var.dynamodb_table_arn,
        "${var.dynamodb_table_arn}/index/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "secrets" {
  name = "secrets-access"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.origin_secret.arn
    }]
  })
}

# Lambda function
resource "aws_lambda_function" "api" {
  function_name = "${var.app_name}-api"
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  timeout       = 30
  memory_size   = 512

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic,
    aws_iam_role_policy.ecr,
    aws_iam_role_policy.dynamodb,
    aws_iam_role_policy.secrets,
  ]

  environment {
    variables = {
      AWS_LWA_PORT      = "8080"
      DYNAMODB_TABLE    = var.dynamodb_table_name
      COGNITO_ISSUER    = var.cognito_issuer
      COGNITO_CLIENT_ID = var.cognito_client_id
      ORIGIN_SECRET_ARN = aws_secretsmanager_secret.origin_secret.arn
      CLOUDFRONT_DOMAIN = var.cloudfront_domain
    }
  }
}

# Allow public invocation via Function URL (resource-based policy required even for auth_type=NONE)
resource "aws_lambda_permission" "function_url" {
  statement_id           = "AllowFunctionUrlInvocation"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Lambda Function URL (auth: NONE — protected by X-Origin-Secret)
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"

  cors {
    allow_credentials = false
    allow_origins     = ["*"]
    allow_methods     = ["*"]
    allow_headers     = ["*"]
    max_age           = 0
  }
}

output "function_url" {
  value = aws_lambda_function_url.api.function_url
}

output "function_arn" {
  value = aws_lambda_function.api.arn
}

output "origin_secret_arn" {
  value = aws_secretsmanager_secret.origin_secret.arn
}

output "origin_secret_value" {
  value     = random_password.origin_secret.result
  sensitive = true
}
