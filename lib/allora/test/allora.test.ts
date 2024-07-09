import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AlloraStack } from '../lib/allora-stack';

test('Stack has correct resources', () => {
  const app = new cdk.App();
  const stack = new AlloraStack(app, 'TestStack', {
    env: { account: 'xxxxxxxxxxx', region: 'us-east-1' },
    amiId: 'ami-04b70fa74e45c3917',
    instanceType: 't2.medium',
    vpcMaxAzs: 1,
    vpcNatGateways: 0,
    vpcSubnetCidrMask: 24,
    resourceNamePrefix: 'AlloraWorkerTest',
  });

  const template = Template.fromStack(stack);

  // Check for VPC
  template.hasResourceProperties('AWS::EC2::VPC', {
    CidrBlock: Match.stringLikeRegexp('10.0.0.0/16'),
  });

  // Check for Security Group with inbound TCP 9010 rule
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Allow inbound TCP 9010',
    SecurityGroupIngress: [
      {
        IpProtocol: 'tcp',
        FromPort: 9010,
        ToPort: 9010,
        CidrIp: '0.0.0.0/0',
      },
    ],
  });

  // Check for EC2 Instance
  template.hasResourceProperties('AWS::EC2::Instance', {
    InstanceType: 't2.medium',
    ImageId: 'ami-04b70fa74e45c3917',
    BlockDeviceMappings: [
      {
        DeviceName: '/dev/sda1',
        Ebs: {
          VolumeSize: 30,
          VolumeType: 'gp3',
        },
      },
    ],
  });

  // Check for EIP
  template.resourceCountIs('AWS::EC2::EIP', 1);

  // Check for EIP Association
  template.hasResourceProperties('AWS::EC2::EIPAssociation', {
    InstanceId: Match.anyValue(),
  });

  // Check for S3 Bucket
  template.resourceCountIs('AWS::S3::Bucket', 1);

  // Check for Bucket Deployment
  template.hasResourceProperties('Custom::CDKBucketDeployment', {
    DestinationBucketName: {
      'Ref': Match.anyValue(),
    },
    DestinationBucketKeyPrefix: 'user-data',
    Prune: true,
    ServiceToken: {
      'Fn::GetAtt': [
        Match.anyValue(),
        'Arn'
      ]
    },
    SourceBucketNames: [
      Match.anyValue(),
    ],
    SourceObjectKeys: [
      Match.stringLikeRegexp('.*\\.zip')
    ]
  });

  // Check for S3 bucket policy to allow read access to the EC2 instance
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    Bucket: {
      'Ref': Match.anyValue(),
    },
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: [
            "s3:PutBucketPolicy",
            "s3:GetBucket*",
            "s3:List*",
            "s3:DeleteObject*"
          ],
          Effect: 'Allow',
          Resource: [
            {
              'Fn::GetAtt': [
                Match.anyValue(),
                'Arn',
              ],
            },
            {
              'Fn::Join': [
                '',
                [
                  {
                    'Fn::GetAtt': [
                      Match.anyValue(),
                      'Arn'
                    ]
                  },
                  '/*'
                ]
              ],
            }
          ],
          Principal: {
            AWS: {
              'Fn::GetAtt': [
                Match.anyValue(),
                'Arn',
              ],
            },
          },
        }),
      ]),
      Version: '2012-10-17'
    },
  });
});
