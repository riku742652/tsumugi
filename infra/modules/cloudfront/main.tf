variable "app_name" {
  type = string
}

variable "lambda_function_url" {
  type        = string
  description = "Lambda Function URL (without trailing slash)"
}

variable "lambda_function_name" {
  type        = string
  description = "Lambda function name (for resource-based policy)"
}

# S3 bucket for frontend static files
resource "aws_s3_bucket" "frontend" {
  bucket = "${var.app_name}-frontend"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront Origin Access Control — S3
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.app_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront Origin Access Control — Lambda
resource "aws_cloudfront_origin_access_control" "lambda" {
  name                              = "${var.app_name}-lambda-oac"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# S3 bucket policy: allow CloudFront OAC
data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket.json
}

# Lambda origin domain (strip https:// and trailing slash)
locals {
  lambda_origin_domain = replace(replace(var.lambda_function_url, "https://", ""), "/", "")
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  # Origin 1: S3 (frontend)
  origin {
    origin_id                = "s3-frontend"
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # Origin 2: Lambda Function URL (API) — signed by OAC with SigV4
  origin {
    origin_id                = "lambda-api"
    domain_name              = local.lambda_origin_domain
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default behavior: S3
  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  # /api/* → Lambda
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "lambda-api"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = true
      headers      = ["Origin", "X-Authorization", "Content-Type"]
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  # SPA fallback: serve index.html for S3 404 (missing routes).
  # 403 is intentionally omitted — API errors must not be rewritten to 200.
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }
}

# Restrict Lambda Function URL invocation to this CloudFront distribution only.
# authorization_type=NONE is kept (AWS_IAM breaks POST with chunked encoding).
# The source_arn condition ensures only this distribution's requests are accepted.
resource "aws_lambda_permission" "allow_cloudfront_invoke_function_url" {
  statement_id           = "AllowCloudfrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.lambda_function_name
  principal              = "*"
  source_arn             = aws_cloudfront_distribution.main.arn
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "allow_cloudfront_invoke_function" {
  statement_id  = "AllowCloudfrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.main.arn
}

output "distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "distribution_domain" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}
