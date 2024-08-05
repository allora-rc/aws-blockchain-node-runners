import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { SingleNodeConstruct, SingleNodeConstructCustomProps } from "../../constructs/single-node"
import * as fs from 'fs';
import * as path from 'path';
import * as nag from "cdk-nag";
import * as iam from "aws-cdk-lib/aws-iam";
import * as configTypes from "../../constructs/config.interface";
import * as nodeCwDashboard from "./assets/node-cw-dashboard"
import * as cw from 'aws-cdk-lib/aws-cloudwatch';

interface AlloraStackEnvironment extends cdk.Environment {
  account: string;
  region: string;
}

export interface AlloraStackProps extends cdk.StackProps {
  instanceType: string;
  vpcMaxAzs: number;
  vpcNatGateways: number
  vpcSubnetCidrMask: number;
  resourceNamePrefix: string;
  dataVolume: configTypes.DataVolumeConfig;
  env: AlloraStackEnvironment
  alloraWorkerName: string;
  alloraTopicId: string;
  alloraEnv: string;
  alloraNetworkName: string;
  alloraAccountName: string;
  alloraAccountMnemonic: string;
  alloraAccountPassphrase: string;
  alloraNodeRpc: string;
}


export class AlloraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AlloraStackProps) {
    super(scope, id, props);

    const {
      env, 
      instanceType, 
      resourceNamePrefix, 
      dataVolume, 
      alloraWorkerName, 
      alloraTopicId, 
      alloraEnv, 
      alloraNetworkName,
      alloraAccountName,
      alloraAccountMnemonic,
      alloraAccountPassphrase,
      alloraNodeRpc
    } = props;
    const { region } = env;

    const STACK_NAME = cdk.Stack.of(this).stackName;
    const STACK_ID = cdk.Stack.of(this).stackId;

    

    // Create S3 Bucket
    const bucket = new s3.Bucket(this, `${resourceNamePrefix}Bucket`, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Upload node.sh to S3
    new s3deploy.BucketDeployment(this, `${resourceNamePrefix}ScriptDeployment`, {
      sources: [s3deploy.Source.asset(path.join(__dirname, 'assets', 'user-data'))],
      destinationBucket: bucket,
      destinationKeyPrefix: 'user-data', // optional prefix in destination bucket
    });

    // Create VPC
    const vpc = new ec2.Vpc(this, `${resourceNamePrefix}Vpc`, {
      maxAzs: props.vpcMaxAzs,
      natGateways: props.vpcNatGateways,
      subnetConfiguration: [{
        cidrMask: props.vpcSubnetCidrMask,
        name:`${resourceNamePrefix}PublicSubnet`,
        subnetType: ec2.SubnetType.PUBLIC,
      }]
    });

    // Security Group with inbound TCP port 9010 open
    const securityGroup = new ec2.SecurityGroup(this, `${resourceNamePrefix}SecurityGroup`, {
      vpc,
      allowAllOutbound: true,
      description: 'Allow inbound TCP 9010',
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(9010), 'Allow inbound TCP 9010');

     


    // Getting the snapshot bucket name and IAM role ARN from the common stack
    const importedInstanceRoleArn = cdk.Fn.importValue("EdgeNodeInstanceRoleArn");

    const instanceRole = iam.Role.fromRoleArn(this, "iam-role", importedInstanceRoleArn);

    // Making sure our instance will be able to read the assets
    bucket.grantRead(instanceRole);


    // Define SingleNodeConstructCustomProps
    const singleNodeProps: SingleNodeConstructCustomProps = {
      instanceName: `${resourceNamePrefix}Instance`,
      instanceType: new ec2.InstanceType(instanceType),
      dataVolumes: [ dataVolume ], // Define your data volumes here
      machineImage:new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
        kernel:ec2.AmazonLinuxKernel.KERNEL5_X,
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      role: instanceRole,
      vpc: vpc,
      rootDataVolumeDeviceName: '/dev/sda1',
      securityGroup: securityGroup,
      availabilityZone: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).availabilityZones[0],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    };

    // Instantiate SingleNodeConstruct
    const singleNode = new SingleNodeConstruct(this, `${resourceNamePrefix}SingleNode`, singleNodeProps);

    const instance = singleNode.instance;

    // Read user data script and inject variables
    const userData = fs.readFileSync(path.join(__dirname, 'assets', 'user-data', 'node.sh')).toString();
    const modifiedUserData = cdk.Fn.sub(userData, {
      _AWS_REGION_: region,
      _ASSETS_S3_PATH_: `s3://${bucket.bucketName}/user-data/node.sh`,
      _NODE_CF_LOGICAL_ID_: singleNode.nodeCFLogicalId,
      _STACK_NAME_: STACK_NAME,
      _STACK_ID_: STACK_ID,
      _ALLORA_WORKER_NAME_: alloraWorkerName,
      _ALLORA_TOPIC_ID_: alloraTopicId,
      _ALLORA_ENV_: alloraEnv,
      _ALLORA_NETWORK_NAME_ : alloraNetworkName,
      _ALLORA_ACCOUNT_NAME_ : alloraAccountName,
      _ALLORA_ACCOUNT_MNEMONIC_ : alloraAccountMnemonic,
      _ALLORA_ACCOUNT_PASSPHRASE_ : alloraAccountPassphrase,
      _ALLORA_NODE_RPC_ : alloraNodeRpc,
    });

   // Create UserData for EC2 instance
   const ec2UserData = ec2.UserData.forLinux();
   ec2UserData.addCommands(modifiedUserData);

    instance.addUserData(ec2UserData.render())

    const dashboardString = cdk.Fn.sub(JSON.stringify(nodeCwDashboard.SyncNodeCWDashboardJSON()), {
      INSTANCE_ID: singleNode.instanceId,
      INSTANCE_NAME: `${resourceNamePrefix}Instance`,
      REGION: region,
    });

    new cw.CfnDashboard(this, 'single-cw-dashboard', {
      dashboardName: `AlloraStack-${singleNode.instanceId}`,
      dashboardBody: dashboardString,
    });

    new cdk.CfnOutput(this, "node-instance-id", {
      value: singleNode.instanceId,
    });

    // Elastic IP
    const eip = new ec2.CfnEIP(this, `${resourceNamePrefix}EIP`);
    new ec2.CfnEIPAssociation(this, `${resourceNamePrefix}EIPAssociation`, {
      eip: eip.ref,
      instanceId: singleNode.instanceId,
    });

    nag.NagSuppressions.addResourceSuppressions(
      this,
      [
          {
              id: "AwsSolutions-EC23",
              reason: "Inbound access from any IP is required for this application.",
          },
          {
              id: "AwsSolutions-IAM4",
              reason: "This IAM role requires broad permissions to function correctly.",
          },
          {
              id: "AwsSolutions-IAM5",
              reason: "Full access is needed for administrative tasks.",
          },
          {
              id: "AwsSolutions-S1",
              reason: "Server-side encryption is not required for this bucket.",
          },
          {
              id: "AwsSolutions-EC2",
              reason: "Unrestricted access is required for the instance to operate correctly.",
          },
          {
              id: "AwsSolutions-AS3",
              reason: "No notifications needed for this specific application.",
          },
          {
              id: "AwsSolutions-S2",
              reason: "Access logging is not necessary for this bucket.",
          },
          {
              id: "AwsSolutions-S10",
              reason: "HTTPS requirement is not needed for this bucket.",
          },
      ],
      true
  );
  }
}
