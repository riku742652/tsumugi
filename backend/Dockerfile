FROM public.ecr.aws/lambda/python:3.12

# Lambda Web Adapter — must be embedded in the image for package_type=Image
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/

ENV AWS_LWA_PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/docs

# Clear the Lambda base image entrypoint so CMD is not treated as a Lambda handler;
# this lets the Lambda Web Adapter start uvicorn correctly. See:
# https://github.com/awslabs/aws-lambda-web-adapter
ENTRYPOINT []
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
