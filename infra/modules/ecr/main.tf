variable "app_name" {
  type = string
}

variable "repo_name" {
  type        = string
  description = "ECR repository name (e.g. zaim-csv-api)"
}

resource "aws_ecr_repository" "this" {
  name                 = var.repo_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    app = var.app_name
  }
}

output "repository_url" {
  value = aws_ecr_repository.this.repository_url
}

output "repository_arn" {
  value = aws_ecr_repository.this.arn
}
