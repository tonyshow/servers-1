/**
 * Created by fisher on 2017/23/37.
 */

var pomelo = require('pomelo'),
    logger = require('pomelo-logger').getLogger(__filename),
    _ = require('underscore');

var area = require('../../../domain/area/area'),
    Code = require('../../../../shared/code'),
    playerDao = require('../../../dao/playerDao'),
    dataApi = require('../../../util/dataApi'),
    dataUtils = require('../../../util/dataUtils'),
    //dropUtils = require('../../../domain/area/dropUtils'),
    consts = require('../../../consts/consts'),
    roomManager = require('../../../domain/area/roomManager'),
    roomDao = require('../../../dao/roomDao');
    /*playerShop = require('../../../domain/entity/playerShop'),
    randomShop = require('../../../domain/entity/randomShop'),
    playerRecharge = require('../../../domain/entity/playerRecharge'),
    activityManager = require('../../../domain/activity/activityManager'),
    publisher = require('../../../domain/activity/publisher'),
    Utils =  require('../../../util/utils'),
    inviteManager = require('../../../domain/area/inviteManager'),
    randBossRecordDao = require('../../../dao/randBossRecordDao'),
    common = require('../../../util/common'),
    randBossDao = require('../../../dao/randBossDao')*/

var Handler = function (app) {
    this.app = app;
};

module.exports = function (app) {
    return new Handler(app);
};

var pro = Handler.prototype;

/*
 *   结算离线应发放体力
 * */
function processOfflineEnergy(player) {
    var trigger = pomelo.app.get('cronManager').getTriggerById(consts.AREA_CRON.DISPATCH_ENERGY_CRON_ID),
        nextExecuteTime,
        now = Date.now(),
        resultEnergy, dispatchCnt = 0;
    if (!trigger) {
        return;
    }
    nextExecuteTime = trigger.nextExcuteTime(player.dispatchEnergyTime);
    logger.debug('processOfflineEnergy dispatchEnergyTime = %s', new Date(player.dispatchEnergyTime).toTimeString());
    while (nextExecuteTime < now) {
        ++dispatchCnt;
        if (player.isEnergyFull()) {
            logger.debug('processOfflineEnergy player %s energy full!', player.id);
            break;
        }
        // 发放一次
        resultEnergy = Math.min(player.maxEnergy, player.energy + dispatchCnt * dataUtils.getOptionValue('Sys_StrengthRenewNum', 1));
        if (resultEnergy >= player.maxEnergy) {
            break;
        }
        nextExecuteTime = trigger.nextExcuteTime(nextExecuteTime);
    }
    if (dispatchCnt > 0) {
        player.set('dispatchEnergyTime', now);
        if (!!resultEnergy) {
            player.dispatchEnergy(resultEnergy - player.energy);
            logger.debug('processOfflineEnergy energy %s', resultEnergy);
        }
    }
}

/*
 *   上线时检查是否需要重置购买体力次数
 * */
function processBuyEnergyCntReset(player) {
    var trigger = pomelo.app.get('cronManager').getTriggerById(consts.AREA_CRON.RESET_BUY_ENERGY_CNT_CRON_ID);
    if (!trigger) {
        return;
    }
    var now = Date.now(),
        lastResetTime = player.resetBuyEnergyCntTime || player.createTime,
        nextResetTime = trigger.nextExcuteTime(lastResetTime);
    if (now >= nextResetTime) {
        player.resetBuyEnergyCount(now);
    }
}


pro.enterScene = function (msg, session, next) {
    var playerId = session.get('playerId'), player,self = this;
    logger.debug('enterScene playerId = %s', playerId);
    if (!playerId) {
        console.log('enterScene request entry or create player first!');
        return next(null, {code: Code.FAIL});
    }

    playerDao.onUserLogon(playerId, function (err, success) {
        playerDao.getPlayerAllInfo(playerId, function (err, allInfo) {
            if (!!err || !allInfo) {
                console.log('get player info failed');
                next(null, {code: Code.DB_ERROR});
                return;
            }
            // 注意:检查是否已有实例，须放在异步读取数据库后，否则会拦不住
            // 如果已在线，也应该在当前这个area上，这里将进行替换
            if ((player = area.getPlayer(playerId)))
            {
                return next(null, {code: Code.AREA.AREADY_ONLINE});//XXXXXXXXX此处逻辑还是原来的猎魔人的，暂时直接返回错误码
                logger.info('enterScene player already online!playerId = %s', playerId);
                if (player.leaveTimer)
                {
                    player.clearLeaveTimer();
                    player.sessionId = session.id;
                    player.setFrontendId(session.frontendId);
                    player.setSession(session);
                    next(null, {code: Code.OK, curPlayer: player.getClientInfo()});
                }
                //需要T人
                else
                {
                    var oldSessionId = player.sessionId;
                    // 替换前端信息
                    player.sessionId = session.id;
                    player.setFrontendId(session.frontendId);
                    next(null, {code: Code.OK, curPlayer: player.getClientInfo()});
                    // 踢掉旧连接
                    self.app.get('localSessionService').kickBySid(session.frontendId, oldSessionId);
                }
                return;
            }

            createPlayer(session, allInfo, next);
        });

        if (!!err) {
            console.log('setOnline error!');
            return;
        }
        if (!success) {
            console.log('enterScene setOnline failed!');
        }
    });
};

//所有关于玩家的数据初始化都在这人
function createPlayer(session, allData, next) {
    var dbPlayer = allData.player,
        player;
    dbPlayer.frontendId = session.frontendId;
    dbPlayer.sessionId = session.id;
    player = area.addPlayer(dbPlayer);


    next(null, {code: Code.OK, curPlayer: player.getClientInfo()});
}


//create game room
pro.createRoom = function (msg, session, next) {
    var playerId = session.get('playerId');
    var player = area.getPlayer(playerId);
    logger.debug('createRoom playerId = %s', playerId);

    //判断货币是否足够，扣除创建房间的花费
    //XXXX

    //调用数据库创建房间
    roomDao.createRoom(playerId, function (err, roomId) {
        if(err){
            return next(null, {code: Code.DB_ERROR});
        }
        var newRoomData = {};
        newRoomData.id = roomId;
        newRoomData.createPlayerId = playerId;
        var room = roomManager.addRoom(newRoomData);
        room.addSeatData(player);
        next(null,{code:Code.OK,room:room.getClientInfo()});
    });
}

pro.joinRoom = function (msg,session,next) {
    var playerId = session.get('playerId');
    var player = area.getPlayer(playerId);
    logger.debug('joinRoom playerId = %s data=%j', playerId, msg);

    var roomId = msg.id;//要加入的房间号

    var room = roomManager.getRoom(roomId);
    if(!room){//没找到房间
        return next(null,{code:Code.AREA.ROOM_NOT_FOUND});
    }

    if(room.isMemberFull()){//房间满员
        return next(null,{code:Code.AREA.ROOM_MEMBER_FULL});
    }

    room.addSeatData(player);
    next(null,{code:Code.OK,room:room.getClientInfo()});
}

//准备发牌
pro.ready = function (msg,session,next) {
    var playerId = session.get('playerId');
    var player = area.getPlayer(playerId);
    logger.debug('ready playerId = %s data=%j', playerId, msg);

    var room = roomManager.getRoom(player.roomId);
    if(!room){//没找到房间
        return next(null,{code:Code.AREA.ROOM_NOT_FOUND});
    }
    var _code = room.getReadByPlayerId(playerId);
    return next(null,{code:_code});
}

//出牌
pro.play = function (msg,session,next) {
    var playerId = session.get('playerId');
    var player = area.getPlayer(playerId);
    logger.debug('play playerId = %s data=%j', playerId, msg);

    var room = roomManager.getRoom(player.roomId);
    if(!room){//没找到房间
        return next(null,{code:Code.AREA.ROOM_NOT_FOUND});
    }
    var _code = room.setPlayCards(playerId ,msg.specialType, msg.ordinaryType , msg.cards);
    //都出牌了，要进行各种积分
    if(room.isAllPlay()){
        //第一步，将不是特殊牌型的几个玩家的牌进行比较，分别得出第一二三轮的出牌顺序和得分情况。
        var ordinarySeatList = {};//普通牌型的座位信息 {座位号：座位信息}
        var specialSeatList = {};//特殊牌型的座位信息
        for(var i = 0 ; i < room.seatDataList.length ; i++){
            if(room.seatDataList[i].getspecialType() == consts.SHISANSHUI_SPECIAL.NULL){
                ordinarySeatList[room.seatDataList[i].getSeatIndex()] = room.seatDataList[i];
            }
            else{
                specialSeatList[room.seatDataList[i].getSeatIndex()] = room.seatDataList[i];
            }
        }

        var firstCycle = [];//第一轮出牌顺序和内容*****
        for(var seatIndex in ordinarySeatList){
            var playData = {};
            playData.seatIndex = seatIndex;//出牌的座位号
            playData.ordinaryType = ordinarySeatList[seatIndex].getOrdinaryType();
            playData.cards = ordinarySeatList[seatIndex].getHandData().slice(0,3);//打出的牌编号
            firstCycle.push(playData);
        }
        //按照牌型从大到小排序
        var firstCycleSort = _.sortBy(firstCycle,function(data){
            return -data.ordinaryType;
        });
        var firstScore = [0,0,0,0];//第一轮得分，按座位号顺序*****
        for(var i = 0 ; i < firstCycle.length ; i++){
            for(var j = i + 1 ; j < firstCycle.length ; j++){
                if(firstCycle[i].ordinaryType > firstCycle[j].ordinaryType){
                    firstScore[firstCycle[i].seatIndex] = firstScore[firstCycle[i].seatIndex] + 1;
                    firstScore[firstCycle[j].seatIndex] = firstScore[firstCycle[j].seatIndex] - 1;
                }
                else if(firstCycle[i].ordinaryType == firstCycle[j].ordinaryType){//比较里面的大小
                    var comp = thirteenCards.compareSameType(firstCycle[i].cards,firstCycle[j].cards,firstCycle[i].ordinaryType);
                    if(comp > 0)
                    {
                        firstScore[firstCycle[i].seatIndex] = firstScore[firstCycle[i].seatIndex] + 1;
                        firstScore[firstCycle[j].seatIndex] = firstScore[firstCycle[j].seatIndex] - 1;
                    }
                    else if(comp < 0){
                        firstScore[firstCycle[i].seatIndex] = firstScore[firstCycle[i].seatIndex] - 1;
                        firstScore[firstCycle[j].seatIndex] = firstScore[firstCycle[j].seatIndex] + 1;
                    }
                }
                else{
                    firstScore[firstCycle[i].seatIndex] = firstScore[firstCycle[i].seatIndex] - 1;
                    firstScore[firstCycle[j].seatIndex] = firstScore[firstCycle[j].seatIndex] + 1;
                }
            }
        }

        var secondCycle = [];//第二轮出牌顺序和内容,第一轮中按牌面大小顺序出*****
        firstCycleSort.forEach(function(cycleData){
            var seatData = ordinarySeatList[cycleData.seatIndex];
            var playData = {};
            playData.seatIndex = seatData.seatIndex;
            playData.ordinaryType = seatData.getOrdinaryType();
            playData.cards = seatData.getHandData().slice(3,8);//打出的牌编号
            secondCycle.push(playData);
        });
        //按照牌型从大到小排序
        var secondCycleSort = _.sortBy(secondCycle,function(data){
            return -data.ordinaryType;
        });
        var secondScore = [0,0,0,0];//第一轮得分，按座位号顺序*****
        for(var i = 0 ; i < secondCycle.length ; i++){
            for(var j = i + 1 ; j < secondCycle.length ; j++){
                if(secondCycle[i].ordinaryType > secondCycle[j].ordinaryType){
                    secondScore[secondCycle[i].seatIndex] = secondScore[secondCycle[i].seatIndex] + 1;
                    secondScore[secondCycle[j].seatIndex] = secondScore[secondCycle[j].seatIndex] - 1;
                }
                else if(secondCycle[i].ordinaryType == secondCycle[j].ordinaryType){//比较里面的大小
                    var comp = thirteenCards.compareSameType(secondCycle[i].cards, secondCycle[j].cards, secondCycle[i].ordinaryType);
                    if(comp > 0)
                    {
                        secondScore[secondCycle[i].seatIndex] = secondScore[secondCycle[i].seatIndex] + 1;
                        secondScore[secondCycle[j].seatIndex] = secondScore[secondCycle[j].seatIndex] - 1;
                    }
                    else if(comp < 0){
                        secondScore[secondCycle[i].seatIndex] = secondScore[secondCycle[i].seatIndex] - 1;
                        secondScore[secondCycle[j].seatIndex] = secondScore[secondCycle[j].seatIndex] + 1;
                    }
                }
                else{
                    secondScore[secondCycle[i].seatIndex] = secondScore[secondCycle[i].seatIndex] - 1;
                    secondScore[secondCycle[j].seatIndex] = secondScore[secondCycle[j].seatIndex] + 1;
                }
            }
        }

        var thirdCycle = [];//第三轮出牌顺序和内容,第二轮中按牌面大小顺序出*****
        secondCycleSort.forEach(function(cycleData){
            var seatData = ordinarySeatList[cycleData.seatIndex];
            var playData = {};
            playData.seatIndex = seatData.seatIndex;
            playData.ordinaryType = seatData.getOrdinaryType();
            playData.cards = seatData.getHandData().slice(8,13);//打出的牌编号
            thirdCycle.push(playData);
        });
        var thirdScore = [0,0,0,0];//第一轮得分，按座位号顺序*****
        for(var i = 0 ; i < thirdCycle.length ; i++){
            for(var j = i + 1 ; j < thirdCycle.length ; j++){
                if(thirdCycle[i].ordinaryType > thirdCycle[j].ordinaryType){
                    thirdScore[thirdCycle[i].seatIndex] = thirdScore[thirdCycle[i].seatIndex] + 1;
                    thirdScore[thirdCycle[j].seatIndex] = thirdScore[thirdCycle[j].seatIndex] - 1;
                }
                else if(thirdCycle[i].ordinaryType == thirdCycle[j].ordinaryType){//比较里面的大小
                    var comp = thirteenCards.compareSameType(thirdCycle[i].cards,thirdCycle[j].cards,thirdCycle[i].ordinaryType);
                    if(comp > 0)
                    {
                        thirdScore[thirdCycle[i].seatIndex] = thirdScore[thirdCycle[i].seatIndex] + 1;
                        thirdScore[thirdCycle[j].seatIndex] = thirdScore[thirdCycle[j].seatIndex] - 1;
                    }
                    else if(comp < 0){
                        thirdScore[thirdCycle[i].seatIndex] = thirdScore[thirdCycle[i].seatIndex] - 1;
                        thirdScore[thirdCycle[j].seatIndex] = thirdScore[thirdCycle[j].seatIndex] + 1;
                    }
                }
                else{
                    thirdScore[thirdCycle[i].seatIndex] = thirdScore[thirdCycle[i].seatIndex] - 1;
                    thirdScore[thirdCycle[j].seatIndex] = thirdScore[thirdCycle[j].seatIndex] + 1;
                }
            }
        }

        var specialCycle = [];//特殊牌型出牌*****
        for(var seatIndex in specialSeatList){
            var playData = {};
            playData.seatIndex = seatIndex;//出牌的座位号
            playData.ordinaryType = specialSeatList[seatIndex].getOrdinaryType();
            playData.cards = specialSeatList[seatIndex].getHandData();//打出的牌编号
            specialCycle.push(playData);
        }
    }

    return next(null,{code:_code});
}

//=================================================取名字===============================================================
/*
 *   检查名字长度
 * */
function playerNameLenValid(name) {
    var nameLen = Utils.getLengthInBytes(name);
    return ( nameLen >= consts.PLAYER_NAME_LEN_RANGE.MIN && nameLen <= consts.PLAYER_NAME_LEN_RANGE.MAX);
}

function containsDirtyWord(name) {
    var dirtyWords = dataApi.DirtyWords.all(),
        dirtyWord;
    var len  =_.size(dirtyWords);

    var findValue= _.find( dirtyWords , function (rec) {
        dirtyWord = rec.dirtyWord;
        if (name.indexOf(dirtyWord) >= 0) {
            logger.debug('containsDirtyWord %s', dirtyWord);
            return true;
        }
    });
    return !_.isUndefined( findValue );
}
/*
 *   创建名字
 * */
pro.createPlayerName = function (msg, session, next) {
    logger.debug('createPlayerName playerId = %s, name = %s', session.get('playerId'), msg.name);
    var player = area.getPlayer(session.get('playerId'));
    // if ( player.nameCreated ) {
    //     logger.debug('createPlayerName created before!');
    //     next(null, {code: Code.FAIL});
    //     return;
    // }
    if ( !msg.name ) {
        logger.debug('createPlayerName empty name not allowed!');
        next(null, {code: Code.FAIL});
        return;
    }
    if( player.setNameCnt != 0 ){
        next(null, {code: Code.PLAYER_NAME.NAME_EXIST});
        return;
    }
    if (!playerNameLenValid(msg.name)) {
        next(null, {code: Code.AREA.NAME_LENGTH_OUT_OF_RANGE});
        return;
    }
    if (containsDirtyWord(msg.name)) {
        next(null, {code: Code.AREA.DIRTY_NAME});
        return;
    }


    playerDao.playerExistByName( msg.name, function (err, exist) {
        if (err) {
            next(null, {code: Code.DB_ERROR});
        } else {
            if (exist) {
                next(null, {code: Code.AREA.NAME_CONFLICT});
            } else {
                // 立即保存，仍然有可能重复
                playerDao.createPlayerName( player.id, msg.name, function (err, success) {
                    if (err) {
                        return next(null, {code: Code.DB_ERROR});
                    }
                    if (success) {
                        //player.playername = msg.name;//set('name', msg.name);
                        //player.nameCreated = 1;
                        var cnt = player.setNameCnt+1;
                        player.set('setNameCnt',cnt);
                        player.set('playername',msg.name);
                        next(null, {code: Code.OK});
                    } else {
                        logger.debug('createPlayerName failed!');
                        return next(null, {code: Code.FAIL});
                    }
                });
            }
        }
    });
};
