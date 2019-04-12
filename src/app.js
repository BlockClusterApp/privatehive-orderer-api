const shell = require('shelljs')
const toPascalCase = require('to-pascal-case')
const fs = require('fs')
const app = require('express')()
const MongoClient = require("mongodb").MongoClient
const Config = require('./config');
const isPortReachable = require('is-port-reachable');

const orgName = toPascalCase(process.env.ORG_NAME)
const shareFileDir = process.env.SHARE_FILE_DIR || './crypto' //Make it /etc/hyperledger during deployment
const workerNodeIP = process.env.WORKER_NODE_IP || '127.0.0.1'
const ordererPort = process.env.ORDERER_PORT || 7050
const peerOrgName = toPascalCase(process.env.PEER_ORG_NAME)
const peerOrgAdminCert = process.env.PEER_ORG_ADMIN_CERT
const peerOrgCACert = process.env.PEER_ORG_CA_CERT
const peerWorkerNodeIP = process.env.PEER_WORKERNODE_IP
const peerAnchorPort = process.env.PEER_ANCHOR_PORT
const namespace = process.env.NAMESPACE
const ordererType = process.env.ORDERER_TYPE

async function updateStatus() {
  return new Promise((resolve, reject) => {
    MongoClient.connect(
      Config.getMongoConnectionString(),
      {
        reconnectTries: Number.MAX_VALUE,
        autoReconnect: true,
        useNewUrlParser: true
      },
      function(err, database) {
        if (!err) {
          let db = database.db(Config.getDatabase());
          db.collection("privatehiveOrderers").updateOne(
            { instanceId: orgName.toLowerCase() },
            { $set: { status: "running" } },
            function(err, res) {
              if(err) {
                reject()
              } else {
                resolve()
              }
            }
          );
        } else {
          reject()
        }
      }
    );
  })
}

async function checkIfOrdererReachable() {
  if(ordererType === 'kafka') {
    if(
      await isPortReachable(7050, {host: 'localhost'}) === true && 
      await isPortReachable(2181, {host: `zk-${orgName.toLowerCase()}-0.zk-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local`}) === true &&
      await isPortReachable(2181, {host: `zk-${orgName.toLowerCase()}-1.zk-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local`}) === true &&
      await isPortReachable(2181, {host: `zk-${orgName.toLowerCase()}-2.zk-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local`}) === true &&
      await isPortReachable(9093, {host: `kafka-${orgName.toLowerCase()}-0.kafka-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local`}) === true &&
      await isPortReachable(9093, {host: `kafka-${orgName.toLowerCase()}-1.kafka-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local`}) === true &&
      await isPortReachable(9093, {host: `kafka-${orgName.toLowerCase()}-2.kafka-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local`}) === true
    ) {
      await updateStatus()
    } else {
      setTimeout(checkIfOrdererReachable, 5000);
    }
  } else {
    if(
      await isPortReachable(7050, {host: 'localhost'}) === true
    ) {
      await updateStatus()
    } else {
      setTimeout(checkIfOrdererReachable, 5000);
    }
  }
}

if(!fs.existsSync(shareFileDir + "/initCompleted")) {
  const cryptoConfigYaml = `
    OrdererOrgs:
    - Name: ${orgName}
      Domain: orderer.${orgName.toLowerCase()}.com
  `

  shell.mkdir('-p', shareFileDir)
  shell.cd(shareFileDir)
  fs.writeFileSync('./crypto-config.yaml', cryptoConfigYaml)
  shell.exec('cryptogen generate --config=./crypto-config.yaml')

  shell.mkdir('-p', `crypto-config/peerOrganizations/peer.${peerOrgName.toLowerCase()}.com/msp/`)
  shell.mkdir('-p', `crypto-config/peerOrganizations/peer.${peerOrgName.toLowerCase()}.com/msp/admincerts/`)
  shell.mkdir('-p', `crypto-config/peerOrganizations/peer.${peerOrgName.toLowerCase()}.com/msp/cacerts/`)
  fs.writeFileSync(`crypto-config/peerOrganizations/peer.${peerOrgName.toLowerCase()}.com/msp/admincerts/Admin@peer.${peerOrgName.toLowerCase()}.com-cert.pem`, peerOrgAdminCert)
  fs.writeFileSync(`crypto-config/peerOrganizations/peer.${peerOrgName.toLowerCase()}.com/msp/cacerts/ca.peer.${peerOrgName.toLowerCase()}.com-cert.pem`, peerOrgCACert)

  let kafkaConfig = ''

  if(ordererType === 'kafka') {
    kafkaConfig = `
    Kafka:
    Brokers:
        - kafka-${orgName.toLowerCase()}-0.kafka-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local:9093
        - kafka-${orgName.toLowerCase()}-1.kafka-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local:9093
        - kafka-${orgName.toLowerCase()}-2.kafka-svc-${orgName.toLowerCase()}.${namespace}.svc.cluster.local:9093
    ` 
  }

  const configTxYaml = `
    Organizations:
      - &${orgName} 
        Name: ${orgName}
        ID: ${orgName}
        MSPDir: crypto-config/ordererOrganizations/orderer.${orgName.toLowerCase()}.com/msp
      - &${peerOrgName}
        Name: ${peerOrgName}
        ID: ${peerOrgName}
        MSPDir: crypto-config/peerOrganizations/peer.${peerOrgName.toLowerCase()}.com/msp
        AnchorPeers:
          - Host: ${peerWorkerNodeIP}
            Port: ${peerAnchorPort}
  
    Channel: &ChannelDefaults
      Policies:
        Readers:
          Type: ImplicitMeta
          Rule: "ANY Readers"
        Writers:
          Type: ImplicitMeta
          Rule: "ANY Writers"
        Admins:
          Type: ImplicitMeta
          Rule: "ANY Admins"

    Profiles:
      OneOrgGenesis:
        <<: *ChannelDefaults
        Orderer:
          OrdererType: ${ordererType}
          Addresses:
              - ${workerNodeIP}:${ordererPort}
          BatchTimeout: 2s
          BatchSize:
              MaxMessageCount: 10
              AbsoluteMaxBytes: 98 MB
              PreferredMaxBytes: 512 KB
          ${kafkaConfig}
          Organizations:
            - *${orgName}
        Consortiums:
          SingleMemberConsortium:
              Organizations:
                - *${peerOrgName}
      OneOrgChannel:
        Consortium: SingleMemberConsortium
        Application:
            Organizations:
                - *${peerOrgName}
  `

  fs.writeFileSync('./configtx.yaml', configTxYaml)
  shell.exec('FABRIC_CFG_PATH=$PWD configtxgen -profile OneOrgGenesis -outputBlock ./genesis.block')

  fs.writeFileSync('./initCompleted', "initCompleted")

  setTimeout(checkIfOrdererReachable, 1000);
}

app.listen(3000, () => console.log('API Server Running'))